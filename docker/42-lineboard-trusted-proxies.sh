#!/bin/sh
# Which networks may tell nginx a client's address in X-Forwarded-For (see nginx.conf): the proxy in
# front of the container, such as Azure App Service's front end. Written at every start.
#
#   unset            private and link-local networks (the platform's internal proxies)
#   TRUSTED_PROXIES="10.0.0.0/8 192.0.2.10"   only these (addresses or CIDR ranges, space separated)
#   TRUSTED_PROXIES=none                       no proxy: every client is keyed by its own address
set -eu
out=/etc/nginx/snippets/trusted-proxies.conf
list=${TRUSTED_PROXIES-"10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 fc00::/7 fe80::/10 ::1/128"}

echo "# Generated at container start from TRUSTED_PROXIES." > "$out"
if [ "$list" = "none" ]; then
  echo "lineboard: no trusted proxies; clients are keyed by their own address"
  exit 0
fi
for net in $list; do
  case "$net" in
    *[!0-9A-Fa-f.:/]* | "")
      echo "lineboard: TRUSTED_PROXIES entry '$net' is not an address or range; ignored" >&2
      continue
      ;;
  esac
  echo "$net 1;" >> "$out"
done
echo "lineboard: trusting X-Forwarded-For from: $list"
