#!/usr/bin/env bash
# Phase 1 proofs with the moss_nodump add-on. Usage: proof-nodump.sh STEP
# Steps: stop-old up check procs crash control orphan-worker orphan-postmaster pid-reuse at-rest
#        supervisor OLD_BINARY, missing-install, at-rest-all, planted-socket OLD_BINARY
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

# crash_supervisor UP_BINARY LABEL OUT: start install A with UP_BINARY, run each at-rest checker,
# crash the supervisor with SIGABRT and record what the crash handler saw.
#
# Rust's own SIGSEGV handler swallows a SIGSEGV sent with kill, so the supervisor would carry on.
# SIGABRT takes the kernel's crash-dump path, as a real fault or an abort does.
crash_supervisor() {
  local up=$1 label=$2 out=$3
  local log=$L/up-$label.jsonl
  BIN=$up up_bg $A "$log" > /dev/null
  wait_event "$log" ready 120 || return 1
  local sup; sup=$(json_field "$log" ready supervisor_pid)
  local pm; pm=$(postmaster_of $A)
  local before; before=$(wc -l < /var/log/apport.log)
  touch "$B/runs/crash-marker-$label"
  {
    echo "# $label: supervisor $sup, postmaster $pm"
    echo "owner of /proc/$sup/status: uid $(stat -c %u /proc/$sup/status) (its real uid: $(awk '/^Uid:/{print $2}' /proc/$sup/status))"
    echo "core limit (soft, hard): $(awk '/^Max core file size/{print $5, $6}' /proc/$sup/limits)"
    echo "core_pattern: $(cat /proc/sys/kernel/core_pattern)"
    for checker in "$up" "$BIN"; do
      [ "$checker" = "$up" ] && who="the moss-db that started it" || who="this moss-db"
      echo "# at-rest crash-dump check by $who:"
      "$checker" at-rest --root $A | python3 -I -c "import json,sys
d=json.load(sys.stdin); print('status', d.get('status'))
[print(c) for c in d['checks'] if c['item']=='Crash dumps']"
      [ "$up" = "$BIN" ] && break
    done
    kill -ABRT "$sup"
    wait_gone "$sup" && echo "# supervisor $sup ended" || echo "# supervisor $sup STILL RUNNING"
    local i=0; while [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done   # give a crash handler 5 s
    echo "# crash-handler log lines naming pid $sup:"
    tail -n +$((before+1)) /var/log/apport.log | grep "pid $sup," || echo "(none)"
    echo "# new files in /var/crash:"
    find /var/crash -newer "$B/runs/crash-marker-$label" 2>/dev/null | grep . || echo "(none)"
    wait_gone "$pm" && echo "# postmaster $pm stopped with its supervisor" || echo "# postmaster $pm STILL RUNNING"
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
    python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('status', d['status']); [print(c) for c in d['checks'] if c['item']=='Crash dumps']" $L/32-at-rest-with-addon.json ;;
  supervisor)
    # supervisor OLD_BINARY: the supervisor holds every database password. Crash one started by a
    # moss-db from before it guarded itself, then one started by this moss-db.
    old=${2:?usage: proof-nodump.sh supervisor OLD_BINARY}
    crash_supervisor "$old" old-binary $L/36a-supervisor-crash-old-binary.txt
    crash_supervisor "$BIN" new-binary $L/36b-supervisor-crash-new-binary.txt ;;
  missing-install)
    # Commands that only read an install must not create one, even under a mistyped root.
    up_bg $A $L/37-up.jsonl > /dev/null
    wait_event $L/37-up.jsonl ready 120 || exit 1
    missing=$RUNS/no-such-install
    {
      for cmd in status check stop; do
        echo "# $cmd --root <missing>: exit $("$BIN" $cmd --root $missing > $L/37-$cmd-missing.json 2>&1; echo $?)"
        cat $L/37-$cmd-missing.json
      done
      [ -e $missing ] && echo "# $missing EXISTS" || echo "# the missing root is still missing"
      echo "# status --root <real>: exit $("$BIN" status --root $A > $L/37-status.json 2>&1; echo $?)"
      echo "# check --root <real>: exit $("$BIN" check --root $A > $L/37-check.json 2>&1; echo $?)"
      python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['server'])" $L/37-check.json
      echo "# stop --root <real>: exit $("$BIN" stop --root $A > $L/37-stop.json 2>&1; echo $?)"
      cat $L/37-stop.json
    } > $L/37-commands-on-missing-install.txt 2>&1
    cat $L/37-commands-on-missing-install.txt ;;
  at-rest-all)
    # Every place the report's at-rest table lists, with the database running.
    up_bg $A $L/38-up.jsonl > /dev/null
    wait_event $L/38-up.jsonl ready 120 || exit 1
    "$BIN" at-rest --root $A --path "Home folder=$HOME" --path "Shared memory=/dev/shm" > $L/38-at-rest-after-review.json 2>&1
    echo "at-rest exit $?"
    "$BIN" stop --root $A > /dev/null
    python3 -I -c "import json,sys
d=json.load(open(sys.argv[1])); print('status', d['status']); print('message', d['message'])
[print(c['item'], '|', c['status'], '|', c['evidence'][0]) for c in d['checks']]" $L/38-at-rest-after-review.json ;;
  planted-socket)
    # planted-socket OLD_BINARY: a long root makes the socket folder fall back to a predictable
    # name in /tmp. A reboot empties /tmp, and then another user can create that name first.
    # Plant it with a state file that points at a fake server, and see what each moss-db sends.
    old=${2:?usage: proof-nodump.sh planted-socket OLD_BINARY}
    unset XDG_RUNTIME_DIR TMPDIR
    long=$RUNS/long-root-so-the-socket-folder-falls-back-to-a-shared-folder
    theirs=$RUNS/planted fake_log=$L/39-fake-server.txt out=$L/39-planted-socket-folder.txt
    rm -rf "$long" "$theirs"
    "$BIN" init --root "$long" --pg "$PG" > $L/39-init.json 2>&1 || { cat $L/39-init.json; exit 1; }
    run=$(python3 -I -c "import hashlib,os,sys
print('/tmp/moss-db-' + hashlib.sha256(os.path.realpath(sys.argv[1]).encode()).hexdigest()[:12])" "$long")
    mkdir "$theirs"
    python3 -I -c "import json,sys
json.dump({'endpoint': {'socket_dir': sys.argv[1], 'port': 5432}}, open(sys.argv[1] + '/state.json', 'w'))" "$theirs"
    python3 -I "$(dirname "$0")/fake-pg-server.py" "$theirs/.s.PGSQL.5432" "$long/secrets/moss_admin" "$fake_log" &
    fake=$!
    for _ in $(seq 50); do [ -S "$theirs/.s.PGSQL.5432" ] && break; sleep 0.1; done
    # try LABEL: run check with the old and this moss-db; show what reached the fake server.
    try() {
      for which in old new; do
        local b=$old; [ $which = new ] && b=$BIN
        : > "$fake_log"
        echo "## $which moss-db check: exit $("$b" check --root "$long" > $L/39-check-$1-$which.json 2>&1; echo $?)"
        cat $L/39-check-$1-$which.json
        echo "## reached the fake server:"; grep . "$fake_log" || echo "(nothing)"
      done
    }
    {
      echo "# the root is long, so the socket folder is $run"
      [ -d "$run" ] && echo "# init made it: $(stat -c 'owner uid %u, mode %a' "$run")"
      rm -rf "$run"; echo "# a reboot empties /tmp: the socket folder is gone"
      echo; echo "# plant 1: $run is a link to a folder with a state file and a fake server"
      ln -s "$theirs" "$run"; try link
      rm "$run"; mkdir "$run"; chmod 777 "$run"; cp "$theirs/state.json" "$run/"
      echo; echo "# plant 2: $run is a real folder anyone can write to, with the same state file"
      echo "# (it is ours, because a second account was not used; another user's folder fails earlier)"
      try open
      chmod 700 "$run"
      echo; echo "# plant 3: $run is private and ours, but its state file names the fake server's folder"
      try private
      rm -rf "$run"
      echo; echo "# the normal fallback still works: up makes the folder, check connects through it"
      up_bg "$long" $L/39-up.jsonl > /dev/null
      wait_event $L/39-up.jsonl ready 120 && echo "# up: ready, socket folder $(stat -c 'owner uid %u, mode %a' "$run")"
      echo "# check: exit $("$BIN" check --root "$long" > $L/39-check-normal.json 2>&1; echo $?)"
      python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print('server', d['server'])" $L/39-check-normal.json
      echo "# stop: $("$BIN" stop --root "$long")"
    } > "$out" 2>&1
    kill $fake
    rm -rf "$long" "$theirs" "$run"
    cat "$out" ;;
  *) echo "unknown step"; exit 2 ;;
esac
