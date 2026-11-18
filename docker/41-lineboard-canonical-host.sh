#!/bin/sh
# Optional: redirect the other spelling of the site's address (with or without "www.") to
# CANONICAL_HOST, so the app lives on a single origin. Browsers keep sign-ins, notes saved without
# an account, the remembered encryption key and passkey origins per origin, so serving the app on
# both "example.com" and "www.example.com" splits them in two.
#
#   CANONICAL_HOST=example.com      www.example.com/... -> 301 https://example.com/...
#   CANONICAL_HOST=www.example.com  example.com/...     -> 301 https://www.example.com/...
#   unset                           no redirect (every hostname is served)
#
# Only that one alternate hostname is redirected: the platform's own hostname (e.g.
# *.azurewebsites.net) and health probes are left alone.
set -eu
out=/etc/nginx/snippets/canonical-host.conf
host=$(printf '%s' "${CANONICAL_HOST:-}" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#[/:].*$##')

if [ -z "$host" ]; then
  : > "$out"
  echo "lineboard: CANONICAL_HOST not set, serving every hostname"
  exit 0
fi
case "$host" in
  *[!a-z0-9.-]* | .* | *. | *..*)
    : > "$out"
    echo "lineboard: CANONICAL_HOST '$host' is not a hostname; not redirecting" >&2
    exit 0
    ;;
esac
case "$host" in
  www.*) other=${host#www.} ;;
  *) other=www.$host ;;
esac

cat > "$out" <<CONF
# Generated at container start from CANONICAL_HOST.
if (\$host = $other) {
  return 301 https://$host\$request_uri;
}
CONF
echo "lineboard: redirecting $other to https://$host"
