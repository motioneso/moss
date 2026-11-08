#!/usr/bin/env bash
# Measures what one account's confined agent can reach, with an unconfined control run.
#
#   containment.sh <target-dir> <runner-root>
#
# <target-dir> holds moss-confine, moss-tool-gateway and examples/launch-rules. The confined run
# uses the exact rules the runner gives alice's agent, read from launch-rules. Plants stand-ins
# for bob's files, the database, and a Moss process holding a secret in its environment.
set -u
T=$1 R=$2 A=$R/accounts/alice B=$R/accounts/bob
mkdir -p "$A/home" "$B/work" "$B/agent-home" "$B/run" "$R/db-standin"
echo secret > "$B/work/secret.txt"
echo signin > "$B/agent-home/auth-standin"
echo lease > "$B/run/gw-standin.lease"
echo rows > "$R/db-standin/base.dat"
[ -f "$R/runner.secret" ] || echo standin > "$R/runner.secret"
env MOSS_STANDIN_SECRET=standin-value sleep 300 & MP=$!
trap 'kill $MP; rm -f /dev/shm/moss-containment-probe' EXIT
mapfile -t RULES < <("$T/examples/launch-rules" "$R" alice "$A/home" /bin/bash "$T/moss-tool-gateway" "$T/moss-confine")

probes=$(cat <<P
t(){ if eval "\$2" >/dev/null 2>&1; then echo "\$1: REACHED"; else echo "\$1: blocked"; fi; }
t "other account's work folder" "cat $B/work/secret.txt"
t "other account's agent home" "cat $B/agent-home/auth-standin"
t "other account's tool-gateway lease" "cat $B/run/gw-standin.lease"
t "runner secret (Moss data folder)" "cat $R/runner.secret"
t "database files" "cat $R/db-standin/base.dat"
t "shared memory folder (write)" "echo x > /dev/shm/moss-containment-probe"
t "shared temporary folder (write)" "echo x > /tmp/moss-containment-probe-\$\$ && rm /tmp/moss-containment-probe-\$\$"
t "Moss process environment" "grep -q standin-value /proc/$MP/environ"
t "Moss process memory" "python3 -c 'f=open(\"/proc/$MP/mem\",\"rb\");m=[l for l in open(\"/proc/$MP/maps\") if \"[stack]\" in l][0];f.seek(int(m.split(\"-\")[0],16));f.read(16)'"
t "another process's command line" "grep -q sleep /proc/$MP/cmdline"
t "key store (session bus)" "busctl --user --address=unix:path=/run/user/$(id -u)/bus list"
t "own folder (write, should be reached)" "echo x > $A/work/probe && rm $A/work/probe"
t "/dev/null (write, should be reached)" "echo x > /dev/null"
P
)
echo "== unconfined (control)"
bash <<<"$probes"
echo "== confined as alice, with the runner's launch rules"
"$T/moss-confine" "${RULES[@]}" -- /bin/bash <<<"$probes"
