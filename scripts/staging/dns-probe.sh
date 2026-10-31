#!/bin/bash
# Usage: dns-probe.sh SECONDS URL
# Every second, requests URL through real DNS (no pinning, the machine's own
# resolver and its cache, as a visitor's) and prints
#   "seconds code edge-ip time-s | addresses DNS gives now"
# 000 means no answer within 10 s. For health-checked DNS drills (plan 3.1).
SECS=$1 URL=$2
HOST=$(echo "$URL" | sed -E 's|^https?://([^/:]+).*|\1|')
start=$(date +%s%N); end=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt "$end" ]; do
  t=$(awk -v n="$(date +%s%N)" -v s="$start" 'BEGIN{printf "%.0f", (n-s)/1e9}')
  r=$(curl -s -o /dev/null --max-time 10 -w '%{http_code} %{remote_ip} %{time_total}' "$URL")
  dns=$(getent ahostsv4 "$HOST" | awk '{print $1}' | sort -u | tr '\n' ' ')
  echo "$t $r | $dns"
  sleep 1
done
