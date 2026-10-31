#!/bin/bash
# Edge cache checks (plan Phase 0.5.1), through one edge.
#
#   scripts/staging/phase05-check.sh EDGE_IP [APP_HOST] [APP2_HOST]
#
# APP_HOST and APP2_HOST run scripts/staging/test-app.ts with different
# LABELs (defaults: app / app2 under jrok-staging.koompi.cloud). Each path is
# requested twice: the second answer must come from the edge (X-Cache-Status:
# HIT, and the app's own hit count unchanged) exactly when the app marked it
# shareable. Exits 1 on any failure.
set -u
EDGE=$1
APP=${2:-app.jrok-staging.koompi.cloud}
APP2=${3:-app2.jrok-staging.koompi.cloud}
fail=0
req() { curl -s -D - -o /tmp/phase05.body --resolve "$1:443:$EDGE" "https://$1$2" -H 'Accept-Encoding: gzip' --compressed ${3:+-H "$3"} | tr -d '\r' | awk -F': ' 'tolower($1)=="x-cache-status"{print $2}'; }
check() { # name, wanted second status (HIT or not-HIT), path, [header]
  local p="$3$(date +%s%N)"  # fresh URL each run
  local path="$3?v=$p"
  req "$APP" "$path" "${4:-}" >/dev/null; local b1; b1=$(cat /tmp/phase05.body)
  local s2; s2=$(req "$APP" "$path" "${4:-}"); local b2; b2=$(cat /tmp/phase05.body)
  local ok=0
  if [ "$2" = HIT ]; then [ "$s2" = HIT ] && [ "$b1" = "$b2" ] && ok=1
  else [ "$s2" != HIT ] && [ "$b1" != "$b2" ] && ok=1; fi
  [ $ok = 1 ] && r=PASS || { r=FAIL; fail=1; }
  printf '%s  %-46s second: %-6s %s\n' "$r" "$1" "${s2:-none}" "$(echo "$b2" | tr -d '\n')"
}
check "public, max-age: cached"            HIT     /cache/public
check "s-maxage: cached"                   HIT     /cache/smaxage
check "max-age only (browser-only): not"   not-HIT /cache/maxage
check "private: not cached"                not-HIT /cache/private
check "public + Set-Cookie: not cached"    not-HIT /cache/cookie
check "no Cache-Control: not cached"       not-HIT /cache/none
check "public, with Authorization: not"    not-HIT /cache/public "Authorization: Bearer x"

# Same path on two apps must never share a cached copy.
path="/cache/public?v=collide$(date +%s%N)"
req "$APP" "$path" >/dev/null; req "$APP" "$path" >/dev/null; a=$(cat /tmp/phase05.body)
req "$APP2" "$path" >/dev/null; b=$(cat /tmp/phase05.body)
if [[ "$a" == app\ * && "$b" == app2\ * ]]; then r=PASS; else r=FAIL; fail=1; fi
printf '%s  %-46s %s | %s\n' "$r" "same path, two apps: no collision" "$(echo "$a" | tr -d '\n')" "$(echo "$b" | tr -d '\n')"
exit $fail
