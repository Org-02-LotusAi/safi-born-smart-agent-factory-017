#!/usr/bin/env bash
# Writes /run/safi-office/env (mode 0600, owner safi) from SSM Parameter Store SecureString values.
# Uses the instance role (default AWS credential chain of the aws cli). Nothing is stored on disk.
# Runs as root from the systemd unit (ExecStartPre=+). Fails loudly if any parameter cannot be read.
set -euo pipefail

CONF=/etc/safi-office/office.conf
RUN_DIR=/run/safi-office
OUT="$RUN_DIR/env"

if [ ! -r "$CONF" ]; then
  echo "safi-office: $CONF is missing; run office/install.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$CONF"

: "${AWS_REGION:?AWS_REGION missing in $CONF}"
: "${SECRET_PARAM:?SECRET_PARAM missing in $CONF}"
: "${CANDIDATE_PASSCODE_PARAM:?CANDIDATE_PASSCODE_PARAM missing in $CONF}"
: "${TRAINER_PASSCODE_PARAM:?TRAINER_PASSCODE_PARAM missing in $CONF}"

get_param() {
  aws ssm get-parameter --region "$AWS_REGION" --name "$1" --with-decryption \
    --query 'Parameter.Value' --output text
}

mkdir -p "$RUN_DIR"
umask 077
tmp="$(mktemp "$RUN_DIR/env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

anthropic_key="$(get_param "$SECRET_PARAM")"
candidate_pass="$(get_param "$CANDIDATE_PASSCODE_PARAM")"
trainer_pass="$(get_param "$TRAINER_PASSCODE_PARAM")"

for v in "$anthropic_key" "$candidate_pass" "$trainer_pass"; do
  case "$v" in
    ''|None)
      echo "safi-office: an SSM parameter is empty; check the three parameter names in office.json." >&2
      exit 1
      ;;
    *$'\n'*|*\"*|*\'*)
      echo "safi-office: a parameter value contains a newline or a quote, which systemd env files cannot hold safely." >&2
      exit 1
      ;;
  esac
done

{
  printf 'ANTHROPIC_API_KEY=%s\n' "$anthropic_key"
  printf 'CANDIDATE_PASSCODE=%s\n' "$candidate_pass"
  printf 'TRAINER_PASSCODE=%s\n' "$trainer_pass"
} > "$tmp"
chown safi:safi "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$OUT"
trap - EXIT
echo "safi-office: secrets refreshed into $OUT"
