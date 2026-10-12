#!/bin/sh
# Runs on the gateway host (server A) from a systemd timer. Writes the Traefik dynamic file that
# routes every *.<suffix> host to the platform Kong on the database server over WireGuard.
#
# Traefik's ACME resolver only requests certificates for Host() matchers or tls.domains, never
# for a HostRegexp, and a wildcard needs a DNS challenge. So the router matches by HostRegexp
# and lists each project host in tls.domains; the list comes from the control plane's /hosts
# (public hostnames only). The file is rendered here, from validated names, so nothing the
# control plane returns can reach Traefik's config verbatim. If /hosts is unreachable the
# current file stays.
set -eu
NAME=${NAME:-supa-platform-staging}
SUFFIX=${SUFFIX:-supa.example.com}
HOSTS_URL=${HOSTS_URL:-http://10.10.0.1:8011/hosts}
KONG_URL=${KONG_URL:-http://10.10.0.1:8010}
OUT=${OUT:-/data/coolify/proxy/dynamic/$NAME.yaml}

hosts=$(curl -fsS --max-time 5 "$HOSTS_URL") || exit 0
esc=$(printf '%s' "$SUFFIX" | sed 's/\./\\./g')
rule=$(printf "HostRegexp(\`^[a-z0-9-]+\\\\.%s\$\`)" "$esc")
tmp=$(mktemp)
{
  echo "# Managed by /usr/local/bin/$NAME-sync (deploy/platform/gateway). Do not edit."
  echo "http:"
  echo "  middlewares:"
  echo "    $NAME-https:"
  echo "      redirectScheme: {scheme: https}"
  echo "  routers:"
  echo "    $NAME-http:"
  printf "      rule: '%s'\n" "$rule"
  echo "      entryPoints: [http]"
  echo "      middlewares: [$NAME-https]"
  echo "      service: $NAME"
  echo "    $NAME:"
  printf "      rule: '%s'\n" "$rule"
  echo "      entryPoints: [https]"
  echo "      service: $NAME"
  echo "      tls:"
  echo "        certResolver: letsencrypt"
  echo "        domains:"
  n=0
  for h in $hosts; do
    case "$h" in
      *."$SUFFIX") ;;
      *) continue ;;
    esac
    printf '%s' "${h%."$SUFFIX"}" | grep -Eqx '[a-z]{20}' || continue
    echo "          - main: $h"
    n=$((n + 1))
  done
  echo "  services:"
  echo "    $NAME:"
  echo "      loadBalancer:"
  echo "        servers:"
  echo "          - url: $KONG_URL"
} > "$tmp"
if [ -f "$OUT" ] && cmp -s "$tmp" "$OUT"; then
  rm -f "$tmp"
else
  chmod 644 "$tmp"
  mv "$tmp" "$OUT"
fi
