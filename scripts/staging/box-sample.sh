#!/bin/bash
# CPU of the agent, the test app and autocannon on the test droplet (2 vCPU: 200% = whole machine).
D=${1:-20}
tot() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat; }
idle() { awk '/^cpu /{print $5+$6}' /proc/stat; }
pt() { local s=0; for p in "$@"; do [ -r /proc/$p/stat ] && s=$((s + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $s; }
A=$(systemctl show -p MainPID --value stg-agent); T=$(systemctl show -p MainPID --value stg-app); C=$(pgrep -f 'autocannon' | tr '\n' ' ')
t1=$(tot); i1=$(idle); a1=$(pt $A); b1=$(pt $T); c1=$(pt $C)
sleep "$D"
t2=$(tot); i2=$(idle); a2=$(pt $A); b2=$(pt $T); c2=$(pt $C)
dt=$(( (t2-t1)/2 ))   # per-core jiffies, so one busy core reads 100%
echo "box: busy $((100*((t2-t1)-(i2-i1))/dt))% of 200% (agent $((100*(a2-a1)/dt))%, app $((100*(b2-b1)/dt))%, autocannon $((100*(c2-c1)/dt))%)"
