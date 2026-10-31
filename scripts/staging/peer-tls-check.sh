#!/bin/bash
# Edges reaching each other over HTTPS (plan step 1.5, P10), on staging.
#
#   scripts/staging/peer-tls-check.sh
#
# Stops the test app's agent on edge1, so every request through edge1 crosses
# to edge2, then checks that the crossing is HTTPS with the peer key: the visitor
# address survives it (and an allowlist sees it), nothing of jrok's reaches the
# app, WebSockets cross too, the fallback while edge1's jrok is down works the
# same way, and nobody but an edge gets into the edge-to-edge entry. Restores
# the agent, jrok and the allowlist on exit. Secrets from the staging env file
# (CERT_SYNC_API_KEY). See docs/plans/staging-runbook.md.
set -uo pipefail
# shellcheck disable=SC1090
. "${JROK_STAGING_ENV:-$HOME/.config/jrok-staging/secrets.env}"
E1=159.223.71.81 E2=188.166.181.1 BOX=174.138.17.236
BASE=jrok-staging.koompi.cloud
APP=app.$BASE
pass=0 fail=0

result() { # result NAME EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass + 1)); else echo "FAIL  $1: expected '$2', got '$3'"; fail=$((fail + 1)); fi
}
on() { local host=$1; shift; ssh -n -o BatchMode=yes "root@$host" "$@"; }
# From this machine, through edge1.
via_e1() { curl -s --max-time 10 --resolve "$APP:443:$E1" "$@"; }
# Whether /sse (six events, 0.5 s apart) arrives as it is sent: the first event
# within 2 s ("live"), not with the rest at 3 s when some hop buffered it.
sse_live() {
  local start end
  start=$(date +%s%N)
  via_e1 -N "https://$APP/sse" | head -1 >/dev/null
  end=$(date +%s%N)
  [ $(((end - start) / 1000000)) -lt 2000 ] && echo live || echo "buffered ($(((end - start) / 1000000)) ms to the first event)"
}
allowlist() { # allowlist JSON-ARRAY (empty: allow all)
  local body='{"mode":"allow-all"}'
  [ -n "$1" ] && body="{\"mode\":\"allowlist\",\"allowedIps\":$1}"
  curl -s -o /dev/null --max-time 10 -X POST "https://$BASE/security/ip/app" \
    -H "Authorization: Bearer $CERT_SYNC_API_KEY" -H 'Content-Type: application/json' -d "$body"
}

cleanup() {
  allowlist ""
  on $E1 'systemctl start jrok'
  on $BOX "sed -i '/$APP/d' /etc/hosts; systemctl start stg-agent@$E1"
}
trap cleanup EXIT

ME=$(curl -s -4 --max-time 10 ifconfig.me)
on $BOX "systemctl stop stg-agent@$E1"
sleep 5

# --- Forwarding (jrok to jrok) ---
result "jrok's port is closed between edges" "closed" \
  "$(on $E1 "timeout 3 bash -c '</dev/tcp/$E2/3000' 2>/dev/null && echo open || echo closed")"
headers=$(via_e1 "https://$APP/headers")
result "forwarded: the app sees this visitor's address" "$ME" "$(echo "$headers" | jq -r '."x-forwarded-for"')"
result "forwarded: no x-jrok-* header reaches the app" "" "$(echo "$headers" | jq -r 'keys[] | select(startswith("x-jrok-"))' | tr '\n' ' ')"
result "forwarded: edge2's nginx took it from edge1 (HTTPS entry)" "yes" \
  "$(on $E2 "tail -n 200 /var/log/nginx/access.log | grep -q '^$E1 .*\"GET /headers ' && echo yes || echo no")"
result "forwarded: the test box's address, from the test box" "$BOX" \
  "$(on $BOX "curl -s --max-time 10 --resolve $APP:443:$E1 https://$APP/headers" | jq -r '."x-forwarded-for"')"
result "forwarded: an event stream arrives live" "live" "$(sse_live)"

# --- Allowlist on the receiving edge sees the real visitor ---
allowlist "[\"$BOX\"]"
sleep 12 # security sync: every edge within 10 s
result "allowlist: the allowed visitor gets through edge1" "200" \
  "$(on $BOX "curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve $APP:443:$E1 https://$APP/")"
result "allowlist: anyone else is refused through edge1" "403" "$(via_e1 -o /dev/null -w '%{http_code}' "https://$APP/")"
allowlist ""
sleep 12

# --- WebSocket relay (wss:// between edges) ---
on $BOX "grep -q '$APP' /etc/hosts || echo '$E1 $APP' >> /etc/hosts"
ws=$(on $BOX "cd /tmp && cat > ws-check.ts <<'EOF'
const ws = new WebSocket('wss://$APP/ws-echo');
const t = setTimeout(() => { console.log('timeout'); process.exit(); }, 8000);
ws.onopen = () => ws.send('across edges');
ws.onmessage = (m) => { console.log((typeof m.data === 'string' ? 'text: ' : 'binary: ') + m.data); clearTimeout(t); ws.close(); process.exit(); };
ws.onclose = (e) => { console.log('closed ' + e.code); process.exit(); };
EOF
bun ws-check.ts")
on $BOX "sed -i '/$APP/d' /etc/hosts"
result "WebSocket through edge1 reaches the app on edge2, text as text" "text: echo: across edges" "$ws"

# --- Fallback while edge1's jrok is down (nginx gateway, HTTPS to edge2) ---
on $E1 'systemctl stop jrok'
sleep 2
codes=""
for _ in 1 2 3 4 5; do codes="$codes$(via_e1 -o /dev/null -w '%{http_code}' "https://$APP/") "; done
result "fallback: requests through edge1 while its jrok is down" "200 200 200 200 200 " "$codes"
result "fallback: the app sees this visitor's address" "$ME" "$(via_e1 "https://$APP/headers" | jq -r '."x-forwarded-for"')"
result "fallback: an event stream arrives live" "live" "$(sse_live)"
on $E1 'systemctl start jrok'

# --- Nobody but an edge gets into the entry ---
result "entry: refused to a visitor (by edge name)" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://stg-edge2.$BASE/" -H "X-Jrok-Forwarded-Host: $APP")"
result "entry: refused to a visitor (by shared name)" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "jrok-peer.$BASE:443:$E2" "https://jrok-peer.$BASE/" -H "X-Jrok-Forwarded-Host: $APP")"
body=$(on $E1 "curl -s --max-time 10 -w ' HTTP %{http_code}' https://stg-edge2.$BASE/headers -H 'X-Jrok-Forwarded-Host: $APP' -H 'X-Jrok-Peer-Key: wrong' -H 'X-Forwarded-For: 192.0.2.1'")
result "entry: an edge without the key can't choose the visitor address" "$E1" \
  "$(echo "${body% HTTP *}" | jq -r '."x-forwarded-for"' 2>/dev/null || echo "${body:0:120}")"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
