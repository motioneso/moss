#!/usr/bin/env bash
#
# run-gate.sh — the one supported way to run a long gate from an agent session.
#
# WHY THIS EXISTS (the 19-hour stall, 2026-07-27, lane #1273 / issue #1342)
#
# A full `pnpm verify:foundation` runs 15-25 minutes. The Claude Bash tool caps a
# single call at 600000 ms (10 min). So the recipe our skills used to document —
#
#     pnpm verify:foundation > /tmp/cb-vf.log 2>&1; echo "VF_EXIT=$?"
#
# — cannot be followed in the foreground for a full gate. Every agent therefore
# improvised its own background run plus a hand-rolled wait loop, and the
# improvised wait is where it broke. One lane wrote:
#
#     while pgrep -f "<worktree>/node_modules" >/dev/null; do sleep 10; done
#
# Every Claude Bash call is wrapped in
# `/bin/bash -c source ~/.claude/shell-snapshots/snapshot-bash-*.sh && <cmd>`,
# and that wrapper's command line contains the worktree path and the command
# text. `pgrep -f` matched those wrapper shells — and the wait loop itself —
# long after the real node/vitest process was gone, so the predicate never went
# false. The gate had actually died at `db:migrate` 19 hours earlier with
# Postgres `error: tuple concurrently updated` (concurrent DDL from a second
# worktree). Nobody could tell, because the log had no terminal marker.
#
# THE RULE THIS ENCODES: a process list cannot distinguish "still working" from
# "died hours ago". Liveness is decided by an artifact — a trap-guaranteed
# sentinel line, plus the log's mtime — and never by `pgrep`/`ps`.
#
# USAGE
#
#   scripts/run-gate.sh start [--gate <pnpm-script>] [--exclusive] [--keep-db]
#       DROP/CREATEs a fresh isolated gate database, exports JARVIS_PGDATABASE,
#       launches the gate fully detached, prints the log path, and returns at
#       once. Never blocks.
#
#   scripts/run-gate.sh status [--log <path>]
#       One-shot verdict. Reads the sentinel and the log mtime — nothing else.
#
#   scripts/run-gate.sh wait [--log <path>] [--timeout <seconds>]
#       Blocks until the gate reaches a terminal state, or until the timeout
#       (default 540s, deliberately under the 10-min tool cap) — then exits 3
#       meaning "still running, call me again". An agent polls with repeated
#       `wait` calls and never exceeds a single tool call's budget.
#
#   scripts/run-gate.sh wait --follow [--log <path>]
#       Same sentinel check, same 15s poll, but never gives up early — it only
#       returns once the run reaches a terminal state (0/1/2). This is the one
#       supported way for an agent to wait on a gate: launch this exact command
#       as a single Bash call with run_in_background: true. That call is not
#       holding your turn open, so you can keep doing other work and you'll get
#       exactly one completion notification with the final exit code — no
#       foreground timeout to size, no repeated `wait`/`status` calls.
#
#       AGENTS: without --follow, the Bash tool's DEFAULT timeout is 120s, well
#       under this command's default 540s. Pass an explicit tool timeout of
#       600000 ms when you call plain `wait`, or pass `--timeout 100` and call
#       it more often. Prefer `--follow` backgrounded instead.
#
#   scripts/run-gate.sh stop [--log <path>]
#       Terminates a running gate and waits for its sentinel. Signals the whole
#       process group — signalling the runner shell alone does not work, because
#       bash defers trap handling until the foreground command returns.
#
# EXIT CODES (shared by status and wait — check these, not the text)
#   0  DONE, gate passed (rc=0)
#   1  DONE, gate failed (its rc is printed)
#   2  DEAD — no sentinel and the run is gone (its recorded pid is no longer
#           the leader of its own session running this log). For a foreign log
#           with no recorded pid, falls back to the idle-time bound below.
#   3  RUNNING — no verdict yet
#   4  usage or environment problem
#
# ENVIRONMENT OVERRIDES
#   JARVIS_PG_CONTAINER     dev Postgres container   (default jarv1s-postgres)
#   JARVIS_GATE_DIR         log + lock directory     (default /tmp/jarv1s-gate)
#   JARVIS_GATE_STALE_SECS  idle seconds => DEAD, but ONLY for a log with no
#                           recorded pid (default 900). A real run is judged by
#                           its pid, not its idle time: `test:integration` goes
#                           quiet for many minutes and a 300s bound reported a
#                           live gate DEAD.
#
# NOTES
#   - JARVIS_PGDATABASE is *exported*, never assigned inline: an inline
#     assignment does not survive backgrounding, and a gate that loses it lands
#     on the live `jarv1s` database. That took chat down for 90 minutes once.
#   - The gate database is dropped on success and KEPT on failure so the failure
#     is debuggable. `--keep-db` keeps it either way.
#   - The gate's output is only ever redirected to a file, never piped. A pipe
#     returns the *filter's* exit code, so a red gate reads as green.

set -euo pipefail

CONTAINER="${JARVIS_PG_CONTAINER:-jarv1s-postgres}"
STATE_DIR="${JARVIS_GATE_DIR:-/tmp/jarv1s-gate}"
STALE_SECS="${JARVIS_GATE_STALE_SECS:-900}"
SENTINEL_PREFIX='### FINAL rc='

die() {
  echo "run-gate: $*" >&2
  exit 4
}

# Worktree identity. Every lane gets its own log and its own gate database, so
# two lanes never share either.
repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "not inside a git repository"
}

slug_for() {
  # Lowercase, non-alphanumerics collapsed to underscores, trailing ones
  # trimmed. Postgres identifiers cap at 63 bytes and the `jarvis_gate_` prefix
  # eats 12, so the slug is truncated to 40 for headroom.
  basename "$1" |
    tr '[:upper:]' '[:lower:]' |
    tr -c 'a-z0-9_' '_' |
    sed -e 's/_\{1,\}/_/g' -e 's/_*$//' |
    cut -c1-40
}

pointer_file() { echo "$STATE_DIR/$1.current"; }

resolve_log() {
  # An explicit --log always wins; otherwise use this worktree's latest run.
  if [ -n "${OPT_LOG:-}" ]; then
    echo "$OPT_LOG"
    return
  fi
  local ptr
  ptr="$(pointer_file "$(slug_for "$(repo_root)")")"
  [ -f "$ptr" ] || die "no recorded run for this worktree — pass --log, or run 'start' first"
  cat "$ptr"
}

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

cmd_start() {
  local gate="verify:foundation" exclusive=0 keep_db=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --gate) gate="${2:?--gate needs a pnpm script name}"; shift 2 ;;
      --exclusive) exclusive=1; shift ;;
      --keep-db) keep_db=1; shift ;;
      *) die "unknown option for start: $1" ;;
    esac
  done

  local root slug log gatedb
  root="$(repo_root)"
  slug="$(slug_for "$root")"
  [ -n "$slug" ] || die "could not derive a slug from $root"
  gatedb="jarvis_gate_${slug}"

  # Refuse to point at production under any circumstance. There is a
  # jarv1s-prod-postgres-1 container sitting beside the dev one on this box.
  case "$CONTAINER" in
    *prod*) die "refusing to run a gate against container '$CONTAINER' (looks like production)" ;;
  esac
  docker inspect "$CONTAINER" >/dev/null 2>&1 ||
    die "container '$CONTAINER' not found — is the dev stack up?"

  mkdir -p "$STATE_DIR"
  log="$STATE_DIR/${slug}-$(date +%Y%m%d-%H%M%S).log"

  # Serialize the DROP/CREATE. These touch shared catalogs (pg_database), which
  # per-database isolation does not cover — concurrent create/drop across lanes
  # is one way to produce `tuple concurrently updated`. Cheap: held for a second
  # or two. Use --exclusive to hold it for the whole gate instead (see below).
  local lock="$STATE_DIR/db.lock"
  (
    flock 200
    # PGOPTIONS, not psql --set: --set defines a *psql* variable and leaves the
    # server GUC alone, so the "does not exist, skipping" NOTICE still lands on
    # stderr. DROP DATABASE cannot run inside a transaction block, so we also
    # can't fold a `SET` into the same -c string.
    docker exec -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" \
      psql -U postgres -q -c "DROP DATABASE IF EXISTS $gatedb WITH (FORCE);" >/dev/null
    docker exec -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" \
      psql -U postgres -q -c "CREATE DATABASE $gatedb;" >/dev/null
  ) 200>"$lock" || die "could not provision gate database $gatedb"

  {
    echo "### GATE   pnpm $gate"
    echo "### CWD    $root"
    echo "### DB     $gatedb (container $CONTAINER)"
    echo "### START  $(date -Is)"
    echo
  } >"$log"

  # Exported, not inline — see the header note.
  export JARVIS_PGDATABASE="$gatedb"

  # setsid+nohup so the run outlives this shell. The Bash tool's shell exits the
  # moment the call returns; without full detachment the gate can die with it.
  setsid nohup "$0" __run "$log" "$gate" "$keep_db" "$gatedb" "$exclusive" "$root" \
    >/dev/null 2>&1 &
  disown 2>/dev/null || true

  echo "$log" >"$(pointer_file "$slug")"

  echo "STARTED  gate=pnpm $gate  db=$gatedb"
  echo "LOG=$log"
  echo "Poll with: scripts/run-gate.sh wait"
}

# Writes the terminal sentinel. Installed as the EXIT trap by cmd___run, so it
# lands on a normal finish, on a gate failure, and on SIGTERM/SIGINT (both routed
# through EXIT). It cannot land on SIGKILL — nothing can — which is why `status`
# also applies a staleness bound to the log's mtime.
RUN_LOG=""
RUN_KEEP_DB=""
RUN_GATEDB=""
run_finish() {
  local rc=$?
  [ -n "$RUN_LOG" ] || exit "$rc"
  if [ "$rc" -eq 0 ] && [ "$RUN_KEEP_DB" != "1" ]; then
    docker exec -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" \
      psql -U postgres -q -c "DROP DATABASE IF EXISTS $RUN_GATEDB WITH (FORCE);" >/dev/null 2>&1 || true
    echo "### CLEANUP dropped $RUN_GATEDB" >>"$RUN_LOG"
  else
    echo "### CLEANUP kept $RUN_GATEDB (rc=$rc)" >>"$RUN_LOG"
  fi
  echo "### END    $(date -Is)" >>"$RUN_LOG"
  echo "${SENTINEL_PREFIX}${rc}" >>"$RUN_LOG"
  exit "$rc"
}

# Internal. Runs the gate with a trap-guaranteed sentinel.
cmd___run() {
  local log="$1" gate="$2" keep_db="$3" gatedb="$4" exclusive="$5" root="$6"

  # These MUST be globals, not locals. An EXIT trap runs after the calling
  # function's frame has already unwound, so `local` values are gone by the time
  # it fires — and under `set -u` the trap then dies on its first unbound
  # reference, writing no sentinel at all. That is exactly the failure this
  # script exists to prevent, and the first version of it shipped that bug.
  RUN_LOG="$log"
  RUN_KEEP_DB="$keep_db"
  RUN_GATEDB="$gatedb"

  trap run_finish EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT

  # Recorded so a run can be STOPPED (`kill -TERM <pid>`, which routes through
  # the trap and still writes a sentinel). Never read this to decide liveness —
  # that is the mistake this script exists to prevent. Use `status`.
  echo "### PID    $$" >>"$log"

  # The detached process inherits whatever directory the caller happened to be
  # in; pin it to the worktree root so the gate always runs against this lane.
  # (the EXIT trap writes the sentinel, so a plain exit is enough here)
  cd "$root" || exit 4

  if [ "$exclusive" = "1" ]; then
    # Hold the DB lock for the entire run. Slower across lanes, but it is the
    # only thing that fully removes concurrent-DDL contention during migrations.
    flock "$STATE_DIR/db.lock" pnpm "$gate" >>"$log" 2>&1
  else
    pnpm "$gate" >>"$log" 2>&1
  fi
}

# ---------------------------------------------------------------------------
# status / wait
# ---------------------------------------------------------------------------

# Prints a human line; returns one of the shared exit codes.
verdict() {
  local log="$1" quiet="${2:-0}"
  [ -f "$log" ] || die "no such log: $log"

  local sentinel rc
  sentinel="$(grep -F "$SENTINEL_PREFIX" "$log" | tail -1 || true)"
  if [ -n "$sentinel" ]; then
    rc="${sentinel##"$SENTINEL_PREFIX"}"
    [ "$quiet" = "1" ] || echo "DONE rc=$rc  ($log)"
    [ "$rc" = "0" ] && return 0
    return 1
  fi

  local now mtime age
  now="$(date +%s)"
  mtime="$(stat -c %Y "$log")"
  age=$((now - mtime))

  # No sentinel. Corroborate with the PID the runner recorded for itself.
  #
  # This is NOT the `pgrep -f` mistake. That failed because it matched a
  # *pattern* against every command line on the box, and Claude wraps each Bash
  # call in a shell whose command line contains the worktree path and the
  # command text — so it matched wrapper shells, and the wait loop itself,
  # forever. Here we check one exact PID that this script wrote down, and we
  # additionally require that it still be the leader of its own setsid session
  # AND still be running our `__run` for THIS log. A recycled PID cannot satisfy
  # all three, and no wrapper shell can satisfy any of them.
  local pid alive=unknown
  pid="$(awk '/^### PID/ {print $3; exit}' "$log" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    alive=no
    if [ "$(ps -o sid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ] &&
      ps -o args= -p "$pid" 2>/dev/null | grep -qF -- "__run $log"; then
      alive=yes
    fi
  fi

  if [ "$alive" = "yes" ]; then
    # Quiet ≠ dead. `test:integration` routinely runs many minutes without
    # writing a line, which is why mtime alone gave a false DEAD here once.
    [ "$quiet" = "1" ] || {
      echo "RUNNING  pid $pid alive, last write ${age}s ago  ($log)"
      echo "at: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 3
  fi

  if [ "$alive" = "no" ]; then
    # Process gone and no sentinel: killed hard enough to skip the trap
    # (SIGKILL, OOM, host reboot). Terminal, regardless of mtime.
    [ "$quiet" = "1" ] || {
      echo "DEAD  pid $pid gone with no sentinel (log idle ${age}s)  ($log)"
      echo "last: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 2
  fi

  # No recorded PID — a hand-rolled or foreign log. Fall back to mtime alone.
  if [ "$age" -gt "$STALE_SECS" ]; then
    [ "$quiet" = "1" ] || {
      echo "DEAD  no sentinel, no recorded pid, log idle ${age}s (bound ${STALE_SECS}s)  ($log)"
      echo "last: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 2
  fi

  [ "$quiet" = "1" ] || {
    echo "RUNNING  last write ${age}s ago  ($log)"
    echo "at: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
  }
  return 3
}

cmd_status() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --log) OPT_LOG="${2:?--log needs a path}"; shift 2 ;;
      *) die "unknown option for status: $1" ;;
    esac
  done
  local log
  log="$(resolve_log)"
  verdict "$log" || return $?
}

cmd_stop() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --log) OPT_LOG="${2:?--log needs a path}"; shift 2 ;;
      *) die "unknown option for stop: $1" ;;
    esac
  done
  local log pid i
  log="$(resolve_log)"

  if grep -qF "$SENTINEL_PREFIX" "$log"; then
    verdict "$log" || true
    return 0
  fi

  pid="$(grep '### PID' "$log" | awk '{print $3}' | tail -1)"
  [ -n "$pid" ] || die "no PID recorded in $log"

  # Signal the whole process GROUP, not just the runner shell. `start` launches
  # under setsid, so the run is its own session and pid == pgid. Signalling the
  # shell alone is not enough: bash defers trap handling until the foreground
  # command returns, so `pnpm` would keep running and the sentinel would not
  # land until the gate finished on its own.
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null ||
    die "could not signal pid $pid (already gone?)"

  for i in $(seq 1 20); do
    sleep 1
    if grep -qF "$SENTINEL_PREFIX" "$log"; then
      verdict "$log" || true
      return 0
    fi
  done
  echo "STOPPED signal sent to pgid $pid but no sentinel after 20s — check $log" >&2
  return 2
}

cmd_wait() {
  local timeout=540 follow=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --log) OPT_LOG="${2:?--log needs a path}"; shift 2 ;;
      --timeout) timeout="${2:?--timeout needs seconds}"; shift 2 ;;
      --follow) follow=1; shift ;;
      *) die "unknown option for wait: $1" ;;
    esac
  done

  local log deadline rc
  log="$(resolve_log)"
  deadline=$(($(date +%s) + timeout))

  while :; do
    rc=0
    verdict "$log" 1 || rc=$?
    if [ "$rc" -ne 3 ]; then
      verdict "$log" || true
      return "$rc"
    fi
    if [ "$follow" -eq 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      verdict "$log" || true
      echo "(timeout after ${timeout}s — not a failure; call wait again)"
      return 3
    fi
    sleep 15
  done
}

# ---------------------------------------------------------------------------

main() {
  [ $# -gt 0 ] || die "usage: run-gate.sh {start|status|wait} [options]"
  local sub="$1"
  shift
  case "$sub" in
    start) cmd_start "$@" ;;
    status) cmd_status "$@" ;;
    wait) cmd_wait "$@" ;;
    stop) cmd_stop "$@" ;;
    __run) cmd___run "$@" ;;
    *) die "unknown subcommand: $sub" ;;
  esac
}

main "$@"
