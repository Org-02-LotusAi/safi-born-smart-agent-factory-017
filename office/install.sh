#!/usr/bin/env bash
# Installs a SAFI Office release on the Linux instance (run as root, normally via SSM AWS-RunShellScript).
#
#   install.sh --sha <bundle-sha256> --release <id> --region <r> --port <p> --host <h> --secure-cookie <0|1> \
#              --secret-param <name> --candidate-param <name> --trainer-param <name> \
#              ( --bundle-file <path> | --bucket <b> --key <k> )
#
# Verifies the bundle SHA-256, builds the release in a temp folder under /opt/safi-office/releases
# (extract + `npm ci --omit=dev --ignore-scripts`), moves it into place, repoints /opt/safi-office/current
# (the previous release is kept for rollback), installs the systemd unit, restarts the service and
# health-checks it. Any failure exits non-zero. Re-deploying the release that is already live never
# deletes it: it is only reconfigured and restarted.
#
# Test hooks (defaults are the production values): SAFI_APP_DIR, SAFI_OFFICE_DATA_DIR, SAFI_CONF_DIR,
# SAFI_SYSTEMD_DIR, SAFI_HEALTH_TRIES (30), SAFI_HEALTH_SLEEP (2).
set -euo pipefail

APP="${SAFI_APP_DIR:-/opt/safi-office}"
DATA="${SAFI_OFFICE_DATA_DIR:-/var/lib/safi-office}"
CONF_DIR="${SAFI_CONF_DIR:-/etc/safi-office}"
SYSTEMD_DIR="${SAFI_SYSTEMD_DIR:-/etc/systemd/system}"
CONF="$CONF_DIR/office.conf"
KEEP_RELEASES=3
HEALTH_TRIES="${SAFI_HEALTH_TRIES:-30}"
HEALTH_SLEEP="${SAFI_HEALTH_SLEEP:-2}"

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
# These values are written into a file that systemd and a root shell both read, so only plain characters are allowed.
case "$REGION" in *[!a-z0-9-]*) die "region has unsafe characters" ;; esac
case "$HOST" in 127.0.0.1|0.0.0.0) ;; *) die "--host must be 127.0.0.1 or 0.0.0.0 (the health check uses 127.0.0.1)" ;; esac
for v in SECRET_PARAM CANDIDATE_PARAM TRAINER_PARAM; do
  case "${!v}" in *[!A-Za-z0-9/_.-]*) die "parameter name for $v has unsafe characters" ;; esac
done
case "$SECURE_COOKIE" in 0|1) ;; *) die "--secure-cookie must be 0 or 1" ;; esac
if [ -z "$BUNDLE_FILE" ] && { [ -z "$BUCKET" ] || [ -z "$KEY" ]; }; then
  die "give --bundle-file or --bucket and --key"
fi

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 22 LTS (22.9 or newer) or Node 24 LTS on this instance (SOW 016 prerequisite), then deploy again."
node_major="$(node -v | sed 's/^v//; s/\..*//')"
case "$node_major" in ''|*[!0-9]*) die "could not read the Node.js version ($(node -v))" ;; esac
node_minor="$(node -v | sed 's/^v[0-9]*\.//; s/\..*//')"
case "$node_minor" in ''|*[!0-9]*) die "could not read the Node.js version ($(node -v))" ;; esac
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 9 ]; }; then
  die "Node.js $(node -v) is too old. Node 22.9 or newer (22 LTS or 24 LTS) is required."
fi
for c in aws npm tar sha256sum curl systemctl; do
  command -v "$c" >/dev/null 2>&1 || die "required command '$c' is missing on this instance."
done

# --- fetch and verify ----------------------------------------------------------
WORK="$(mktemp -d)"
STAGING=''
cleanup() { rm -rf "$WORK"; if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi; }
trap cleanup EXIT
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

# --- build the release (never touches the live one) ---------------------------------
REL="$APP/releases/$RELEASE"
current_target=''
current_target="$(readlink "$APP/current" 2>/dev/null || true)"
if [ "${current_target%/}" = "$REL" ]; then
  say "release $RELEASE is already live; keeping it and only refreshing settings and restarting"
elif [ -f "$REL/.safi-release-ok" ]; then
  say "release $RELEASE is already installed (not live); reusing it"
else
  rm -rf "$REL"   # only a half-built leftover can exist here; it is not live
  STAGING="$APP/releases/.build-$RELEASE.$$"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  tar -xzf "$BUNDLE_FILE" -C "$STAGING"
  [ -f "$STAGING/server/index.mjs" ] || die "bundle does not contain server/index.mjs"
  say "installing dependencies (npm ci --omit=dev --ignore-scripts)"
  (cd "$STAGING" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || die "npm ci failed; nothing was changed and the release that was live is still live."
  chown -R root:root "$STAGING"
  chmod -R go-w "$STAGING"
  chmod 0755 "$STAGING/office/fetch-secrets.sh" "$STAGING/office/install.sh"
  : > "$STAGING/.safi-release-ok"
  mv "$STAGING" "$REL"
  STAGING=''
fi
[ -f "$REL/server/index.mjs" ] || die "release $RELEASE is incomplete (server/index.mjs missing)."

# --- config (no secrets) ---------------------------------------------------------
# The release to go back to if the new one is unhealthy: whatever is live now, unless that is this very release.
previous=''
if [ -n "$current_target" ] && [ "${current_target%/}" != "$REL" ]; then previous="$current_target"; fi
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
mkdir -p "$SYSTEMD_DIR"
install -m 0644 "$REL/office/safi-jobcoach.service" "$SYSTEMD_DIR/safi-jobcoach.service"
systemctl daemon-reload
systemctl enable safi-jobcoach >/dev/null 2>&1
systemctl restart safi-jobcoach
say "service restarted, waiting for health"

healthy=''
for _ in $(seq 1 "$HEALTH_TRIES"); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >"$WORK/health.json" 2>/dev/null; then healthy=yes; break; fi
  sleep "$HEALTH_SLEEP"
done
if [ -z "$healthy" ]; then
  journalctl -u safi-jobcoach -n 30 --no-pager >&2 || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    say "health check failed; rolling back to $previous"
    ln -sfn "$previous" "$APP/current.new"
    mv -Tf "$APP/current.new" "$APP/current"
    systemctl restart safi-jobcoach || true
    die "the Office did not become healthy on port $PORT; rolled back to $previous."
  fi
  die "the Office did not become healthy on port $PORT and there is no earlier release to roll back to."
fi
say "health: $(cat "$WORK/health.json")"

# --- prune old releases (keep the newest few for rollback) ---------------------------
# shellcheck disable=SC2012
ls -1dt "$APP"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  if [ "${old%/}" != "$REL" ] && [ "${old%/}" != "${previous%/}" ] && [ "${old%/}" != "${current_target%/}" ]; then rm -rf "$old"; fi
done
say "INSTALL OK release=$RELEASE sha256=$SHA"
