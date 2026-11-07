#!/usr/bin/env bash
# Phase 1 proofs with the moss_nodump add-on. Usage: proof-nodump.sh STEP
# Steps: stop-old up check procs crash control orphan-worker orphan-postmaster pid-reuse at-rest
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
L=$RUNS/logs A=$RUNS/a C=$RUNS/c
NOADDON=$B/pg/no-addon

json_field() { python3 -I -c "import json,sys
for line in open(sys.argv[1]):
    d=json.loads(line)
    if d.get('event')==sys.argv[2]: print(d[sys.argv[3]]); break" "$@"; }

postmaster_of() { head -1 "$1/db/postmaster.pid" 2>/dev/null; }

wait_gone() { local pid=$1 i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ $i -gt 300 ] && return 1; sleep 0.1; done; }

# One line per server process: pid, owner of its /proc status file, real uid, core limit, title.
describe() {
  local pm=$1
  for pid in $pm $(ps -o pid= --ppid "$pm"); do
    printf '%s owner=%s real_uid=%s core_limit=%s %s\n' "$pid" \
      "$(stat -c %u /proc/$pid/status)" "$(awk '/^Uid:/{print $2}' /proc/$pid/status)" \
      "$(awk '/^Max core file size/{print $5}' /proc/$pid/limits)" "$(ps -o args= -p $pid)"
  done
}

# crash ROOT LABEL OUT: crash a busy backend with SIGSEGV and record what the crash handler saw.
crash() {
  local root=$1 label=$2 out=$3
  local hold=$L/hold-$label.jsonl
  "$BIN" hold --root "$root" --seconds 120 > "$hold" 2>&1 &
  wait_event "$hold" holding 30 || return 1
  local pid; pid=$(json_field "$hold" holding backend_pid)
  local before; before=$(wc -l < /var/log/apport.log)
  touch "$B/runs/crash-marker-$label"
  {
    echo "# $label: backend $pid holding $(json_field "$hold" holding rows_read) proof rows"
    echo "owner of /proc/$pid/status: uid $(stat -c %u /proc/$pid/status) (its real uid: $(awk '/^Uid:/{print $2}' /proc/$pid/status))"
    echo "core limit: $(awk '/^Max core file size/{print $5}' /proc/$pid/limits)"
    echo "core_pattern: $(cat /proc/sys/kernel/core_pattern)"
    kill -SEGV "$pid"
    wait_event "$hold" released 30
    local i=0; while [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done   # give a crash handler 5 s
    echo "# session outcome: $(json_field "$hold" released outcome)"
    echo "# crash-handler log lines naming pid $pid:"
    tail -n +$((before+1)) /var/log/apport.log | grep "pid $pid," || echo "(none)"
    echo "# new files in /var/crash:"
    find /var/crash -newer "$B/runs/crash-marker-$label" 2>/dev/null | grep . || echo "(none)"
    echo "# database log:"
    grep -E "PID $pid\)|reinitializing|ready to accept" "$root/logs/postgres.log" | tail -4
  } > "$out" 2>&1
  rm -f "$B/runs/crash-marker-$label"
  cat "$out"
}

case ${1:-} in
  stop-old)
    pm=$(postmaster_of $A)
    "$BIN" stop --root $A > $L/25-stop-old-binary.json 2>&1; echo "stop exit $?"
    wait_gone "$pm" && echo "old postmaster $pm gone" ;;
  up)
    up_bg $A $L/25-up-with-addon.jsonl
    wait_event $L/25-up-with-addon.jsonl ready 120 && cut -c1-600 $L/25-up-with-addon.jsonl ;;
  check)
    "$BIN" check --root $A > $L/26-check-with-addon.json 2>&1; echo "check exit $?"
    python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['server'])" $L/26-check-with-addon.json ;;
  procs)
    describe "$(postmaster_of $A)" | tee $L/26b-processes-with-addon.txt ;;
  crash)
    crash $A with-addon $L/27-crash-with-addon.txt ;;
  control)
    [ -d $NOADDON ] || { cp -al $PG $NOADDON && rm $NOADDON/lib/postgresql/moss_nodump.so; }
    ls $NOADDON/lib/postgresql/ | grep -c nodump
    PG=$NOADDON up_bg $C $L/28-up-without-addon.jsonl
    wait_event $L/28-up-without-addon.jsonl ready 120 || exit 1
    "$BIN" check --root $C --write control > $L/28b-check-without-addon.json 2>&1
    python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['server'])" $L/28b-check-without-addon.json
    "$BIN" at-rest --root $C > $L/28c-at-rest-without-addon.json 2>&1
    python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); [print(c) for c in d['checks'] if c['item']=='Crash dumps']" $L/28c-at-rest-without-addon.json
    crash $C without-addon $L/28d-crash-without-addon.txt
    "$BIN" stop --root $C > $L/28e-stop-without-addon.json 2>&1; echo "stop exit $?" ;;
  orphan-worker)
    sup=$(json_field $L/25-up-with-addon.jsonl ready supervisor_pid); pm=$(postmaster_of $A)
    "$BIN" hold --root $A --seconds 300 > $L/hold-orphan.jsonl 2>&1 &
    wait_event $L/hold-orphan.jsonl holding 30 || exit 1
    backend=$(json_field $L/hold-orphan.jsonl holding backend_pid)
    kill -KILL "$pm"; wait_gone "$pm"; wait_gone "$sup"
    {
      echo "# postmaster $pm killed with SIGKILL; supervisor $sup then exited by itself"
      echo "# server processes still alive afterwards:"
      ps -o pid=,args= -p "$backend" || echo "(none)"
    } > $L/29-orphan-worker.txt
    cat $L/29-orphan-worker.txt
    up_bg $A $L/29b-up-after-orphan-worker.jsonl
    wait_event $L/29b-up-after-orphan-worker.jsonl ready 120 && json_field $L/29b-up-after-orphan-worker.jsonl ready recovered
    kill -0 "$backend" 2>/dev/null && echo "backend $backend STILL ALIVE" || echo "backend $backend ended" ;;
  orphan-postmaster)
    pm=$(postmaster_of $A)
    tr '\0' '\n' < /proc/$pm/cmdline > $B/runs/postmaster-args.txt
    "$BIN" stop --root $A > /dev/null 2>&1; wait_gone "$pm"
    # Start Postgres exactly as the supervisor did, but with no supervisor: a stand-in for a
    # platform with no parent-death signal.
    (cd $A && setsid nohup xargs -d '\n' -a $B/runs/postmaster-args.txt sh -c 'exec "$@"' sh >> $A/logs/postgres.log 2>&1 < /dev/null &)
    i=0; until [ "$(sed -n 8p $A/db/postmaster.pid 2>/dev/null | tr -d ' ')" = ready ]; do i=$((i+1)); [ $i -gt 300 ] && break; sleep 0.1; done
    lone=$(postmaster_of $A)
    { echo "# postmaster $lone running with no supervisor:"; ps -o pid=,ppid=,args= -p "$lone"; } > $L/30-orphan-postmaster.txt
    cat $L/30-orphan-postmaster.txt
    up_bg $A $L/30b-up-with-orphan-postmaster.jsonl
    wait_event $L/30b-up-with-orphan-postmaster.jsonl ready 120 && json_field $L/30b-up-with-orphan-postmaster.jsonl ready recovered ;;
  pid-reuse)
    sup=$(json_field $L/30b-up-with-orphan-postmaster.jsonl ready supervisor_pid); pm=$(postmaster_of $A)
    kill -KILL "$pm"; wait_gone "$pm"; wait_gone "$sup"
    setsid nohup sleep 600 > /dev/null 2>&1 < /dev/null & other=$!
    sed -i "1s/.*/$other/" $A/db/postmaster.pid
    { echo "# postmaster.pid now names pid $other: $(ps -o args= -p $other)"; } > $L/31-pid-reuse.txt
    up_bg $A $L/31b-up-with-reused-pid.jsonl
    wait_event $L/31b-up-with-reused-pid.jsonl ready 120 && json_field $L/31b-up-with-reused-pid.jsonl ready recovered | tee -a $L/31-pid-reuse.txt
    { kill -0 $other && echo "# pid $other afterwards: still running, untouched ($(ps -o args= -p $other))"; } | tee -a $L/31-pid-reuse.txt
    kill $other ;;
  at-rest)
    "$BIN" at-rest --root $A > $L/32-at-rest-with-addon.json 2>&1; echo "exit $?"
    python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('overall', d.get('overall')); [print(c) for c in d['checks'] if c['item']=='Crash dumps']" $L/32-at-rest-with-addon.json ;;
  *) echo "unknown step"; exit 2 ;;
esac
