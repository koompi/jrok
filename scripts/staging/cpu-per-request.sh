#!/bin/bash
# Agent CPU per request: `app` through the connector (stg-conn@<edge>) against
# `app2` through Node CLI agents (stg-agent2@<edge>), the same test app behind
# both. On the test droplet; needs autocannon and jq. Loads edge1 for 20 s each,
# twice, and reads the agents' CPU time from /proc.
EDGE=${1:-159.223.71.81}
hz=$(getconf CLK_TCK)
ticks() { local t=0 p; for u in "$@"; do p=$(systemctl show -p MainPID --value "$u"); t=$((t + $(awk '{print $14 + $15}' "/proc/$p/stat"))); done; echo $t; }
run() { # run NAME HOST UNIT...
  local name=$1 host=$2 a b r; shift 2
  a=$(ticks "$@")
  r=$(NODE_TLS_REJECT_UNAUTHORIZED=0 autocannon -c 50 -d 20 -H "host=$host" -H accept-encoding=gzip -j "https://$EDGE/api/data" 2>/dev/null \
    | jq -r '"\(.requests.total) \(.non2xx) \(.requests.average) \(.latency.p99)"')
  b=$(ticks "$@")
  set -- $r
  awk -v name="$name" -v n="$1" -v bad="$2" -v rps="$3" -v p99="$4" -v t=$((b - a)) -v hz="$hz" \
    'BEGIN { printf "%-18s %6d requests (%s non-2xx), %4.0f req/s, p99 %s ms; agent CPU %.1f s = %.2f ms per request\n", name, n, bad, rps, p99, t/hz, 1000*t/hz/n }'
}
for i in 1 2; do
  run "app (connector)" app.jrok-staging.koompi.cloud "stg-conn@159.223.71.81" "stg-conn@188.166.181.1"
  run "app2 (Node agent)" app2.jrok-staging.koompi.cloud "stg-agent2@159.223.71.81" "stg-agent2@188.166.181.1"
done
