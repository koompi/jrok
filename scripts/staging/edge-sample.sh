#!/bin/bash
# Usage: edge-sample.sh SECONDS. CPU over the window (1 vCPU: 100% = the whole
# machine), split into jrok and nginx, then connection states on port 3000.
D=${1:-20}
tot() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat; }
idle() { awk '/^cpu /{print $5+$6}' /proc/stat; }
pt() { local s=0; for p in "$@"; do [ -r /proc/$p/stat ] && s=$((s + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $s; }
J=$(systemctl show -p MainPID --value jrok); N=$(pgrep nginx | tr '\n' ' ')
t1=$(tot); i1=$(idle); j1=$(pt $J); n1=$(pt $N)
sleep "$D"
t2=$(tot); i2=$(idle); j2=$(pt $J); n2=$(pt $N)
dt=$((t2-t1))
echo "cpu busy $((100*(dt-(i2-i1))/dt))% (jrok $((100*(j2-j1)/dt))%, nginx $((100*(n2-n1)/dt))%) | $(free -m | awk '/Mem/{print "mem used " $3 " of " $2 " MB"}')"
echo "port 3000: $(ss -tan '( sport = :3000 or dport = :3000 )' | awk 'NR>1{print $1}' | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
