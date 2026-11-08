#!/usr/bin/env bash
# Measures what one account's confined agent can reach, with an unconfined control run.
#
#   containment.sh <target-dir> <runner-root> [person-home]
#
# With "person-home", alice's sign-in folder stands in for the person's own home folder, the
# only setup that works until Moss has its own agent sign-in.
#
# <target-dir> holds moss-confine, moss-tool-gateway and examples/launch-rules. The confined run
# uses the exact rules the runner gives alice's agent, read from launch-rules. Plants stand-ins
# for bob's files, the database, and a Moss process holding a secret in its environment. The
# lease file is a stand-in too; no real gateway runs. Another login session's terminal is a real
# pseudo-terminal started here.
set -u
T=$1 R=$2 A=$R/accounts/alice B=$R/accounts/bob
H=$A/home; [ "${3:-}" = person-home ] && H=$R/person-home
mkdir -p "$H" "$A/work" "$B/work" "$B/agent-home" "$B/run" "$R/db-standin"
echo secret > "$B/work/secret.txt"
echo signin > "$B/agent-home/auth-standin"
echo lease > "$B/run/gw-standin.lease"
echo rows > "$R/db-standin/base.dat"
[ -f "$R/runner.secret" ] || echo standin > "$R/runner.secret"
env MOSS_STANDIN_SECRET=standin-value sleep 300 & MP=$!
script -qc "sleep 300" /dev/null </dev/null >/dev/null 2>&1 & SP=$!
sleep 1; PTS=/dev/$(ps -o tty= -p "$(pgrep -P $SP | head -1)" | tr -d ' ')
trap 'kill $MP; pkill -P $SP; kill $SP; rm -f /dev/shm/moss-containment-probe' EXIT
mapfile -t RULES < <("$T/examples/launch-rules" "$R" alice "$H" /bin/bash "$T/moss-tool-gateway" "$T/moss-confine")

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
t "another session's terminal ($PTS)" "exec 3<>$PTS"
t "new pseudo-terminal of its own" "python3 -c 'import pty; pty.openpty()'"
t "login file in the sign-in folder (write)" "mkdir -p $H/.config/systemd/user && echo x > $H/.config/systemd/user/moss-probe.service && rm $H/.config/systemd/user/moss-probe.service"
t "own folder (write, should be reached)" "echo x > $A/work/probe && rm $A/work/probe"
t "/dev/null (write, should be reached)" "echo x > /dev/null"
P
)
echo "== unconfined (control)"
bash <<<"$probes"
echo "== confined as alice, with the runner's launch rules"
"$T/moss-confine" "${RULES[@]}" -- /bin/bash <<<"$probes"
