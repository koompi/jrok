#!/bin/bash
# Usage: probe.sh SECONDS URL EDGE_IP [EDGE_IP...]
# Every 0.5 s, requests URL through each edge (pinned with --resolve, 2 s
# timeout) and prints "seconds code code ...", one column per edge. 000 means
# no answer within 2 s. Summarise a run with:
#   awk '{$1=""; print}' out.txt | uniq -c
SECS=$1 URL=$2; shift 2
HOST=$(echo "$URL" | sed -E 's|^https?://([^/:]+).*|\1|')
start=$(date +%s%N); end=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt "$end" ]; do
  line=$(awk -v n="$(date +%s%N)" -v s="$start" 'BEGIN{printf "%.1f", (n-s)/1e9}')
  for ip in "$@"; do
    line="$line $(curl -s -o /dev/null -m 2 -w '%{http_code}' --resolve "$HOST:443:$ip" "$URL")"
  done
  echo "$line"
  sleep 0.5
done
