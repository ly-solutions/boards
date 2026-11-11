#!/usr/bin/env bash
# Checks a built image for what must not be published; exits non-zero on any finding.
#
#   GITLEAKS=/path/to/gitleaks scripts/image-leak-check.sh <image>
#
# It copies the application folder out of the image (APP_DIR, default /app) without node_modules (published third-party
# packages), adds the image's environment and labels, and looks for:
#   1. Secrets: gitleaks over that tree (GITLEAKS names the binary; required).
#   2. Private network addresses (10/8, 172.16/12, 192.168/16, 100.64/10) other than the example ones of tests and docs.
#      LEAK_CHECK_IP_ALLOW extends the allowed ones (an extended regex of whole addresses).
#   3. Forbidden words, when LEAK_CHECK_FORBIDDEN is set: one extended regex, case-insensitive, in file contents and
#      paths. The words belong to whoever publishes, so they come from the environment (a repository secret) and are
#      not written here; without it this step is skipped.
set -euo pipefail

die() {
  echo "image-leak-check: $*" >&2
  exit 2
}

[ $# -eq 1 ] || die "usage: $0 <image>"
image=$1
app_dir=${APP_DIR:-/app}
gitleaks=${GITLEAKS:-gitleaks}
command -v "$gitleaks" >/dev/null || die "gitleaks not found (set GITLEAKS)"

work=$(mktemp -d)
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

container=$(docker create "$image")
mkdir -p "$work/tree"
docker cp "$container:$app_dir" - | tar -x -C "$work/tree" --exclude='*/node_modules' ||
  die "could not copy $app_dir out of $image"
docker image inspect --format '{{json .Config.Env}} {{json .Config.Labels}}' "$image" >"$work/tree/image-config.json"
cd "$work/tree"

failed=0
report() {
  # report <title> <findings...>: prints them and marks the check failed.
  local title=$1
  shift
  [ $# -gt 0 ] || return 0
  echo "== $title" >&2
  printf '  %s\n' "$@" >&2
  failed=1
}

# 1. Secrets.
if ! "$gitleaks" dir . --no-banner --redact --log-level warn >&2; then
  report "secrets" "gitleaks found the secrets above"
fi

# 2. Private addresses. The allowed ones are the examples of tests and docs: the first hosts of a range, its bounds.
ip_allow='10\.0\.0\.[0-9]{1,3}|10\.1\.2\.3|10\.[0-9]{1,3}\.0\.[01]|192\.168\.[01]\.[0-9]{1,3}|172\.16\.0\.[0-9]{1,3}|172\.31\.255\.255|100\.64\.0\.[0-9]{1,3}|100\.127\.255\.255'
[ -n "${LEAK_CHECK_IP_ALLOW:-}" ] && ip_allow="$ip_allow|$LEAK_CHECK_IP_ALLOW"
private='(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.[0-9]{1,3}\.[0-9]{1,3}'
mapfile -t ips < <(grep -rIoEn -- "(^|[^0-9.])$private([^0-9.]|$)" . |
  sed -E 's|^\./||; s/^([^:]+:[0-9]+):[^0-9]*([0-9.]*[0-9]).*$/\1: \2/' | grep -vE ": ($ip_allow)\$" | sort -u || true)
report "private network addresses" "${ips[@]}"

# 3. Forbidden words.
if [ -n "${LEAK_CHECK_FORBIDDEN:-}" ]; then
  mapfile -t hits < <({
    find . -type f -print | sed 's|^\./||' | grep -iE -- "$LEAK_CHECK_FORBIDDEN" | sed 's/$/ (path)/' || true
    grep -rnaiEo -- "$LEAK_CHECK_FORBIDDEN" . | sed 's|^\./||' | cut -c1-200 || true
  } | sort -u)
  report "forbidden words" "${hits[@]}"
else
  echo "image-leak-check: LEAK_CHECK_FORBIDDEN is not set, forbidden words are not checked" >&2
fi

if [ "$failed" -ne 0 ]; then
  echo "image-leak-check: $image is not fit to publish" >&2
  exit 1
fi
echo "image-leak-check: $image is clean"
