#!/usr/bin/env bash
# Installs a SAFI Office release on the Linux instance (run as root, normally via SSM AWS-RunShellScript).
#
#   install.sh --sha <bundle-sha256> --release <id> --region <r> --port <p> --host <h> --secure-cookie <0|1> \
#              --secret-param <name> --candidate-param <name> --trainer-param <name> \
#              ( --bundle-file <path> | --bucket <b> --key <k> )
#
# Verifies the bundle SHA-256, extracts to /opt/safi-office/releases/<release>, repoints
# /opt/safi-office/current (previous release is kept for rollback), runs `npm ci --omit=dev`,
# installs the systemd unit, restarts the service and health-checks it. Any failure exits non-zero.
set -euo pipefail

APP=/opt/safi-office
DATA=/var/lib/safi-office
CONF_DIR=/etc/safi-office
CONF="$CONF_DIR/office.conf"
KEEP_RELEASES=3

die() { echo "INSTALL FAILED: $*" >&2; exit 1; }
say() { echo "[install] $*"; }

BUNDLE_FILE='' BUCKET='' KEY='' SHA='' RELEASE='' REGION='' PORT='8017' HOST='127.0.0.1' SECURE_COOKIE='0'
SECRET_PARAM='' CANDIDATE_PARAM='' TRAINER_PARAM=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "option $1 needs a value"
  case "$1" in
    --bundle-file) BUNDLE_FILE=$2 ;;
    --bucket) BUCKET=$2 ;;
    --key) KEY=$2 ;;
    --sha) SHA=$2 ;;
    --release) RELEASE=$2 ;;
    --region) REGION=$2 ;;
    --port) PORT=$2 ;;
    --host) HOST=$2 ;;
    --secure-cookie) SECURE_COOKIE=$2 ;;
    --secret-param) SECRET_PARAM=$2 ;;
    --candidate-param) CANDIDATE_PARAM=$2 ;;
    --trainer-param) TRAINER_PARAM=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done

[ "$(id -u)" -eq 0 ] || die "run as root (SSM Run Command does)."
for v in SHA RELEASE REGION SECRET_PARAM CANDIDATE_PARAM TRAINER_PARAM; do
  [ -n "${!v}" ] || die "missing required option for $v"
done
case "$RELEASE" in *[!A-Za-z0-9._-]*|'') die "release id has unsafe characters" ;; esac
case "$PORT" in *[!0-9]*|'') die "port must be a number" ;; esac
case "$SECURE_COOKIE" in 0|1) ;; *) die "--secure-cookie must be 0 or 1" ;; esac
if [ -z "$BUNDLE_FILE" ] && { [ -z "$BUCKET" ] || [ -z "$KEY" ]; }; then
  die "give --bundle-file or --bucket and --key"
fi

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 20 or newer (LTS) on this instance (SOW 016 prerequisite), then deploy again."
node_major="$(node -v | sed 's/^v//; s/\..*//')"
case "$node_major" in ''|*[!0-9]*) die "could not read the Node.js version ($(node -v))" ;; esac
[ "$node_major" -ge 20 ] || die "Node.js $(node -v) is too old. Node 20 or newer (LTS) is required."
for c in aws npm tar sha256sum curl systemctl; do
  command -v "$c" >/dev/null 2>&1 || die "required command '$c' is missing on this instance."
done

# --- fetch and verify ----------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ -z "$BUNDLE_FILE" ]; then
  say "downloading s3://$BUCKET/$KEY"
  aws s3 cp "s3://$BUCKET/$KEY" "$WORK/bundle.tgz" --region "$REGION" --only-show-errors
  BUNDLE_FILE="$WORK/bundle.tgz"
fi
[ -f "$BUNDLE_FILE" ] || die "bundle file $BUNDLE_FILE not found"
actual="$(sha256sum "$BUNDLE_FILE" | cut -d' ' -f1)"
[ "$actual" = "$SHA" ] || die "bundle SHA-256 mismatch (expected $SHA, got $actual). Nothing was installed."
say "bundle sha256 verified"

# --- system user and directories ----------------------------------------------
id safi >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin safi
mkdir -p "$APP/releases" "$DATA" "$CONF_DIR"
chown safi:safi "$DATA"
chmod 0700 "$DATA"

# --- extract ---------------------------------------------------------------------
REL="$APP/releases/$RELEASE"
rm -rf "$REL"
mkdir -p "$REL"
tar -xzf "$BUNDLE_FILE" -C "$REL"
[ -f "$REL/server/index.mjs" ] || die "bundle does not contain server/index.mjs"
say "installing dependencies (npm ci --omit=dev)"
(cd "$REL" && npm ci --omit=dev --no-audit --no-fund) || die "npm ci failed; the previous release (if any) is still active."
chown -R root:root "$REL"
chmod -R go-w "$REL"
chmod 0755 "$REL/office/fetch-secrets.sh" "$REL/office/install.sh"

# --- config (no secrets) ---------------------------------------------------------
previous=''
if [ -L "$APP/current" ]; then previous="$(readlink "$APP/current")"; fi
cat > "$CONF" <<CONF_EOF
SAFI_MODE=office
SAFI_DATA_DIR=$DATA
PORT=$PORT
HOST=$HOST
GIT_SHA=$RELEASE
COOKIE_SECURE=$SECURE_COOKIE
AWS_REGION=$REGION
SECRET_PARAM=$SECRET_PARAM
CANDIDATE_PASSCODE_PARAM=$CANDIDATE_PARAM
TRAINER_PASSCODE_PARAM=$TRAINER_PARAM
CONF_EOF
chmod 0644 "$CONF"

# --- activate ------------------------------------------------------------------------
ln -sfn "$REL" "$APP/current.new"
mv -Tf "$APP/current.new" "$APP/current"
install -m 0644 "$REL/office/safi-jobcoach.service" /etc/systemd/system/safi-jobcoach.service
systemctl daemon-reload
systemctl enable safi-jobcoach >/dev/null 2>&1
systemctl restart safi-jobcoach
say "service restarted, waiting for health"

healthy=''
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >"$WORK/health.json" 2>/dev/null; then healthy=yes; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  journalctl -u safi-jobcoach -n 30 --no-pager >&2 || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    say "health check failed; rolling back to $previous"
    ln -sfn "$previous" "$APP/current.new"
    mv -Tf "$APP/current.new" "$APP/current"
    systemctl restart safi-jobcoach || true
  fi
  die "the Office did not become healthy on port $PORT within 60 seconds."
fi
say "health: $(cat "$WORK/health.json")"

# --- prune old releases (keep the newest few for rollback) ---------------------------
# shellcheck disable=SC2012
ls -1dt "$APP"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  if [ "${old%/}" != "$REL" ] && [ "${old%/}" != "$previous" ]; then rm -rf "$old"; fi
done
say "INSTALL OK release=$RELEASE sha256=$SHA"
