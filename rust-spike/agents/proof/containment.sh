#!/usr/bin/env bash
# Measures what one account's confined agent can reach, with an unconfined control run.
#
#   containment.sh <moss-confine> <runner-root>
#
# Expects <runner-root>/accounts/{alice,bob}. Plants stand-in files for bob, the database and a
# Moss process holding a secret in its environment, then runs the same probes twice.
set -u
C=$1 R=$2 A=$R/accounts/alice
mkdir -p "$A" "$R/accounts/bob/work" "$R/accounts/bob/agent-home" "$R/db-standin"
echo secret > "$R/accounts/bob/work/secret.txt"
echo signin > "$R/accounts/bob/agent-home/auth-standin"
echo rows > "$R/db-standin/base.dat"
[ -f "$R/runner.secret" ] || echo standin > "$R/runner.secret"
env MOSS_STANDIN_SECRET=standin-value sleep 300 & MP=$!
trap 'kill $MP' EXIT

probes=$(cat <<P
t(){ if eval "\$2" >/dev/null 2>&1; then echo "\$1: REACHED"; else echo "\$1: blocked"; fi; }
t "other account's work folder" "cat $R/accounts/bob/work/secret.txt"
t "other account's agent home" "cat $R/accounts/bob/agent-home/auth-standin"
t "runner secret (Moss data folder)" "cat $R/runner.secret"
t "database files" "cat $R/db-standin/base.dat"
t "Moss process environment" "grep -q standin-value /proc/$MP/environ"
t "Moss process memory" "python3 -c 'f=open(\"/proc/$MP/mem\",\"rb\");m=[l for l in open(\"/proc/$MP/maps\") if \"[stack]\" in l][0];f.seek(int(m.split(\"-\")[0],16));f.read(16)'"
t "key store (session bus)" "busctl --user --address=unix:path=/run/user/$(id -u)/bus list"
P
)
echo "== unconfined (control)"
bash <<<"$probes"
echo "== confined as alice (Landlock)"
"$C" --read /usr --read /lib --read /lib64 --read /bin --read /etc --read /proc --read /sys \
  --write /dev --write "$A" -- /bin/bash <<<"$probes"
