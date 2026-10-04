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
#       Launches a throwaway pgvector Postgres server just for this run (own
#       container, own host port, nothing shared with the dev database or any
#       other gate), CREATEs a fresh gate database inside it, exports the
#       database environment at it, launches the gate fully detached
#       (the runner migrates the fresh database first, then runs the gate,
#       so narrowed gates work on empty servers too), confirms the runner
#       recorded its PID (about a second on success),
#       then prints the log path and returns. If no PID lands within the
#       launch bound the start fails loudly (exit 4) and marks the log, so
#       status/wait report DEAD with the reason — a failed launch never reads
#       as RUNNING. The log records the tested commit (### COMMIT),
#       dirty-tree state (### DIRTY), an input fingerprint over commit plus
#       status plus file contents (### FINGERPRINT, so same-files-dirty with
#       different bytes hashes differently), toolchain versions
#       (### TOOLCHAIN), the database-server version (### POSTGRES) and the
#       throwaway container (### GATE_CONTAINER) — repeated in short form by
#       status/wait. Full reuse rule in the verify-gate skill: changed or
#       unknown inputs invalidate reuse.
#
#   scripts/run-gate.sh status [--log <path>]
#       One-shot verdict. Reads the sentinel, the launch-failure marker, and
#       the log mtime — nothing else.
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
#           the leader of its own session running this log); or the runner
#           never launched (launch-failure marker, or a start header with no
#           pid past the launch grace). For a foreign log with no recorded
#           pid, falls back to the idle-time bound below.
#   3  RUNNING — no verdict yet
#   4  usage or environment problem
#
# ENVIRONMENT OVERRIDES
#   JARVIS_GATE_PGIMAGE     Postgres image for the throwaway gate server
#                           (default pgvector/pgvector:pg17, the same image the
#                           dev compose file uses for its postgres service)
#   JARVIS_GATE_PGSHM       /dev/shm size for the throwaway gate server
#                           (default 1g; the 2026-10-03 incident ran on the
#                           Docker default of 64 MB)
#   JARVIS_GATE_PGREADY_SECS
#                           seconds `start` waits for the throwaway server to
#                           accept connections before provisioning (default 60)
#   JARVIS_GATE_DIR         log + lock directory     (default /tmp/jarv1s-gate)
#   JARVIS_GATE_STALE_SECS  idle seconds => DEAD, but ONLY for a log with no
#                           recorded pid (default 900). A real run is judged by
#                           its pid, not its idle time: `test:integration` goes
#                           quiet for many minutes and a 300s bound reported a
#                           live gate DEAD.
#   JARVIS_GATE_LAUNCH_WAIT_SECS
#                           seconds `start` waits for the runner PID before
#                           failing the launch (default 30)
#   JARVIS_GATE_LAUNCH_GRACE_SECS
#                           idle seconds => DEAD for a log with a start header
#                           but no runner pid and no launch marker (default
#                           120). Only reached when `start` itself died before
#                           it could mark the failure.
#
# NOTES
#   - JARVIS_PGDATABASE (and the whole database environment) is *exported*,
#     never assigned inline: an inline assignment does not survive
#     backgrounding, and a gate that loses it lands on the live `jarv1s`
#     database. That took chat down for 90 minutes once.
#   - Every run gets its own throwaway Postgres server, so concurrent gates
#     never share a server with each other or with the dev instance. The
#     container is removed when the run ends on every path — pass, fail,
#     killed, aborted start — and each start sweeps leftover gate containers
#     whose run is no longer alive. `--keep-db` is accepted for compatibility
#     but keeps nothing: the database dies with its server.
#   - The gate's output is only ever redirected to a file, never piped. A pipe
#     returns the *filter's* exit code, so a red gate reads as green.

set -euo pipefail

GATE_IMAGE="${JARVIS_GATE_PGIMAGE:-pgvector/pgvector:pg17}"
GATE_SHM="${JARVIS_GATE_PGSHM:-1g}"
GATE_READY_SECS="${JARVIS_GATE_PGREADY_SECS:-60}"
GATE_NAME_PREFIX="jarv1s-gate-"
GATE_DBHOST="127.0.0.1"
STATE_DIR="${JARVIS_GATE_DIR:-/tmp/jarv1s-gate}"
STALE_SECS="${JARVIS_GATE_STALE_SECS:-900}"
# How long `start` waits for the detached runner to record its PID before
# declaring the launch failed (default 30). Success still returns in about a
# second; only the failure path waits out the full bound.
LAUNCH_WAIT_SECS="${JARVIS_GATE_LAUNCH_WAIT_SECS:-30}"
# Idle bound for a log that has our start header but never got a runner PID
# and carries no launch-failure marker (default 120). The runner records its
# PID within a second of a healthy launch, so an older header-only log means
# the start died before the runner existed — report it DEAD, don't wait out
# the foreign-log bound. Only reached when `start` itself was killed before
# it could write the marker; the normal failed-launch path is immediate.
LAUNCH_GRACE_SECS="${JARVIS_GATE_LAUNCH_GRACE_SECS:-120}"
SENTINEL_PREFIX='### FINAL rc='
LAUNCH_FAILED_PREFIX='### LAUNCH_FAILED '

die() {
  echo "run-gate: $*" >&2
  exit 4
}

# Armed by cmd_start only. Globals because an EXIT trap fires outside the
# function's frame (the same reason cmd___run uses globals).
LAUNCH_LOG=""
LAUNCH_OK=0
LAUNCH_CONTAINER=""

# EXIT trap for cmd_start (#2473): if the shell leaves before the runner's
# PID is confirmed, the log gets a launch-failure marker so no later wait can
# mistake the previous run's result for this one. Covers die, set -e aborts,
# SIGPIPE, TERM and INT. SIGKILL cannot run any trap; the verdict backstop
# below keys on the first header line for that case. A throwaway server that
# already launched is removed here, so an aborted start leaves no container
# behind. Always succeeds.
start_abort() {
  [ "${LAUNCH_OK:-0}" = "1" ] && return 0
  [ -n "${LAUNCH_LOG:-}" ] || return 0
  grep -qF "$LAUNCH_FAILED_PREFIX" "$LAUNCH_LOG" 2>/dev/null && return 0
  echo "${LAUNCH_FAILED_PREFIX}start exited before the runner launched" >>"$LAUNCH_LOG" 2>/dev/null || true
  if [ -n "${LAUNCH_CONTAINER:-}" ]; then
    docker rm -f "$LAUNCH_CONTAINER" >/dev/null 2>&1 || true
    echo "### CLEANUP removed gate container $LAUNCH_CONTAINER (aborted start)" >>"$LAUNCH_LOG" 2>/dev/null || true
  fi
  return 0
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
# throwaway gate server (#2989)
# ---------------------------------------------------------------------------

# Prints a free loopback port. Asks the kernel first (bind 0); without
# python3, probes a random candidate directly. The caller still retries on a
# lost race: docker run fails when another process grabbed the port first.
pick_free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' 2>/dev/null && return 0
  fi
  local port attempt=0
  while [ "$attempt" -lt 20 ]; do
    attempt=$((attempt + 1))
    port=$((55000 + RANDOM % 5000))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

# Launches the throwaway pgvector server for this run: own container, own
# loopback port, generous shm. The name is picked by the caller and already
# reserved in this run's log before the first attempt, so a sibling start
# sweeping mid-launch sees it in a live log. Sets LAUNCH_CONTAINER/LAUNCH_PORT.
# Retries a few times — the picked port can lose a race between the probe and
# docker. The startpid label records which start launched the server, for
# operators reading `docker ps`; the sweep never judges liveness by it.
launch_gate_postgres() {
  local slug="$1" name="$2" attempt=0 port
  command -v docker >/dev/null 2>&1 || die "docker not found — cannot launch the gate database server"
  while [ "$attempt" -lt 10 ]; do
    attempt=$((attempt + 1))
    port="$(pick_free_port)" || die "could not find a free port for the gate database server"
    if docker run -d --name "$name" \
      --label jarv1s.gate=1 --label "jarv1s.gate.slug=$slug" --label "jarv1s.gate.startpid=$$" \
      -p "127.0.0.1:${port}:5432" --shm-size="$GATE_SHM" \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
      "$GATE_IMAGE" >/dev/null 2>&1; then
      LAUNCH_CONTAINER="$name"
      LAUNCH_PORT="$port"
      return 0
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  die "could not launch the gate database server (image $GATE_IMAGE) after 10 attempts"
}

# Waits until the throwaway server accepts connections. Returns nonzero on
# timeout; the caller removes the container and fails the launch loudly.
wait_gate_postgres_ready() {
  local name="$1" waited=0
  while [ "$waited" -lt "$GATE_READY_SECS" ]; do
    if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Removes one throwaway server. Never fails the caller.
remove_gate_container() {
  [ -n "${1:-}" ] || return 0
  docker rm -f "$1" >/dev/null 2>&1 || true
  return 0
}

# Removes the throwaway server a log names, if any. For stop paths where the
# runner is gone and its trap never ran. Never fails the caller.
remove_log_container() {
  local log="$1" container
  container="$(grep -m 1 '^### GATE_CONTAINER ' "$log" 2>/dev/null | awk '{print $3}' || true)"
  [ -n "$container" ] || return 0
  remove_gate_container "$container"
  echo "### CLEANUP removed gate container $container (stop)" >>"$log" 2>/dev/null || true
  return 0
}

# True when some recorded run still references this container AND that run is
# not terminal (RUNNING verdict). A container whose runs all reached a
# sentinel, a launch marker, or a dead runner is a leftover.
gate_container_in_live_run() {
  local name="$1" candidate rc
  for candidate in "$STATE_DIR"/*.log; do
    [ -f "$candidate" ] || continue
    grep -qF "$name" "$candidate" 2>/dev/null || continue
    rc=0
    verdict "$candidate" 1 >/dev/null 2>&1 || rc=$?
    [ "$rc" = "3" ] && return 0
  done
  return 1
}

# Removes leftover gate servers whose run is no longer alive. Runs at each
# start, so a SIGKILLed run (no trap, no sentinel) still gets collected on
# the next one. Never fails the start; records what it removed in this run's
# log when one is already open.
sweep_gate_containers() {
  local names name
  names="$(docker ps -a --filter "name=${GATE_NAME_PREFIX}" --format '{{.Names}}' 2>/dev/null || true)"
  [ -n "$names" ] || return 0
  for name in $names; do
    case "$name" in
      "${GATE_NAME_PREFIX}"*) ;;
      *) continue ;;
    esac
    [ "$name" != "${LAUNCH_CONTAINER:-}" ] || continue
    if gate_container_in_live_run "$name"; then
      continue
    fi
    # No PID-liveness check here on purpose: the name is reserved in the
    # starting run's log before docker run, so a container the sweep can see
    # always has a log line to judge by — and a kill -0 on the recorded
    # starter PID is unsound on a busy box, where the PID can already belong
    # to someone else (observed: a killed start's PID reused before the next
    # sweep, which then kept a dead run's server forever).
    remove_gate_container "$name"
    if [ -n "${LAUNCH_LOG:-}" ]; then
      echo "### SWEEP removed leftover gate container $name" >>"$LAUNCH_LOG" 2>/dev/null || true
    fi
  done
  return 0
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

  mkdir -p "$STATE_DIR"
  log="$STATE_DIR/${slug}-$(date +%Y%m%d-%H%M%S).log"

  # Early pointer (#2473). The pointer names the latest log before anything
  # else that can fail — including the receipt checks, the container checks
  # and provisioning below — so a start killed in its first moments can never
  # leave wait/status reading the previous run's result. The EXIT trap marks
  # the log unless the runner's PID is confirmed.
  echo "### GATE   pnpm $gate" >"$log"
  echo "$log" >"$(pointer_file "$slug")"
  LAUNCH_LOG="$log"
  LAUNCH_OK=0
  trap start_abort EXIT

  # Tested-commit receipt (#2462). Captured here, before the runner launches,
  # so the log identifies exactly what code this run tested. Dirty state
  # includes untracked files (-uall); ignored files are excluded. Failures
  # here never block a gate start — they record as unknown.
  local gate_commit gate_dirty gate_status_list gate_dirty_total
  gate_commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
  gate_dirty="unknown (status failed)"
  gate_status_list=""
  gate_dirty_total=0
  # Branch on the exit code: a failed status stays unknown and must never read
  # as clean. --no-optional-locks never takes the index lock, so this is safe
  # in the shared checkout while another session runs git.
  if gate_status_list="$(git --no-optional-locks -C "$root" status --porcelain=v1 -uall 2>/dev/null)"; then
    if [ -z "$gate_status_list" ]; then
      gate_dirty="clean"
    else
      gate_dirty_total="$(printf '%s\n' "$gate_status_list" | wc -l | tr -d ' ')"
      gate_dirty="dirty (${gate_dirty_total} files)"
    fi
  fi

  # Input fingerprint (#2462). sha256 over the tested commit, the full
  # NUL-separated status (tracked and untracked, ignored excluded), and
  # the content hash of every listed file that still exists in the tree.
  # Two runs with the same files dirty but different bytes hash
  # differently, so changed inputs always invalidate reuse. Only digests
  # enter the log, never file bytes. Any failure records as unknown and
  # never blocks a start.
  local gate_fingerprint fp_status fp_files fp_content
  gate_fingerprint="unknown (status failed)"
  fp_status=""; fp_files=""; fp_content=""
  if fp_status="$(mktemp "$STATE_DIR/fp-status.XXXXXX" 2>/dev/null)" &&
    fp_files="$(mktemp "$STATE_DIR/fp-files.XXXXXX" 2>/dev/null)" &&
    fp_content="$(mktemp "$STATE_DIR/fp-content.XXXXXX" 2>/dev/null)" &&
    git --no-optional-locks -C "$root" status --porcelain=v1 -uall -z >"$fp_status" 2>/dev/null; then
    gate_fingerprint="unknown (hash failed)"
    if {
      while IFS= read -r -d '' rec; do
        for cand in "$rec" "${rec:3}"; do
          if [ -n "$cand" ] && [ -f "$root/$cand" ]; then
            printf '%s\0' "$root/$cand"
            break
          fi
        done
      done <"$fp_status" >"$fp_files"
    } 2>/dev/null && <"$fp_files" xargs -0 -r sha256sum >"$fp_content" 2>/dev/null; then
      local fp_hex
      fp_hex="$(
        {
          printf 'commit %s\0' "$gate_commit"
          cat "$fp_status"
          printf '\0'
          cat "$fp_content"
        } | sha256sum | awk '{print $1}'
      )"
      if [ "${#fp_hex}" -eq 64 ]; then
        gate_fingerprint="sha256:$fp_hex"
      fi
    fi
  fi
  rm -f "$fp_status" "$fp_files" "$fp_content" 2>/dev/null || true

  # Collect servers whose run is already over (#2989). Runs before this
  # run launches its own, so one sweep happens per start.
  sweep_gate_containers

  # Throwaway gate server (#2989). Own container, own loopback port, generous
  # shm — shared with no other gate and never with the dev instance. The name
  # is reserved in the log BEFORE docker run: a sibling start sweeping during
  # our bringing-up window must find it in a live log, or it would collect
  # our server as a leftover (the blocking review finding on this PR). From
  # here on every failure path removes it again (launch timeout below, the
  # EXIT trap on aborted start, the runner's trap on finish or kill).
  local gate_name
  gate_name="${GATE_NAME_PREFIX}${slug}-$(date +%Y%m%d-%H%M%S)-$$-$RANDOM"
  echo "### GATE_CONTAINER $gate_name (starting)" >>"$log"
  launch_gate_postgres "$slug" "$gate_name"
  if ! wait_gate_postgres_ready "$LAUNCH_CONTAINER"; then
    local dead_container="$LAUNCH_CONTAINER"
    remove_gate_container "$dead_container"
    echo "### CLEANUP removed gate container $dead_container (never became ready)" >>"$log"
    echo "${LAUNCH_FAILED_PREFIX}gate database server $dead_container did not accept connections within ${GATE_READY_SECS}s ($(date -Is))" >>"$log"
    LAUNCH_CONTAINER=""
    LAUNCH_OK=1
    die "gate database server $dead_container did not accept connections within ${GATE_READY_SECS}s"
  fi

  # Toolchain and database-server identity (#2462). Compared on reuse:
  # a different node, pnpm, or Postgres can change results without any
  # code diff. Unknown probes never block a start.
  local gate_node gate_pnpm gate_postgres
  gate_node="$(node --version 2>/dev/null || echo unknown)"
  gate_pnpm="$(pnpm --version 2>/dev/null || echo unknown)"
  gate_postgres="$(docker exec "$LAUNCH_CONTAINER" psql -U postgres -tAc 'SHOW server_version;' 2>/dev/null | tr -d '[:space:]' || echo unknown)"
  [ -n "$gate_node" ] || gate_node="unknown (probe failed)"
  [ -n "$gate_pnpm" ] || gate_pnpm="unknown (probe failed)"
  [ -n "$gate_postgres" ] || gate_postgres="unknown (probe failed)"

  # Fresh gate database inside the throwaway server. No lock: the server is
  # ours alone, so no other lane touches its catalogs. The old shared-server
  # lock (and the --exclusive hold) no longer has anything to serialize.
  # PGOPTIONS, not psql --set: --set defines a *psql* variable and leaves the
  # server GUC alone, so the "does not exist, skipping" NOTICE still lands on
  # stderr. DROP DATABASE cannot run inside a transaction block, so we also
  # can't fold a `SET` into the same -c string.
  docker exec -e PGOPTIONS='-c client_min_messages=warning' "$LAUNCH_CONTAINER" \
    psql -U postgres -q -c "DROP DATABASE IF EXISTS $gatedb WITH (FORCE);" >/dev/null ||
    die "could not provision gate database $gatedb"
  docker exec -e PGOPTIONS='-c client_min_messages=warning' "$LAUNCH_CONTAINER" \
    psql -U postgres -q -c "CREATE DATABASE $gatedb;" >/dev/null ||
    die "could not provision gate database $gatedb"

  {
    echo "### CWD    $root"
    echo "### COMMIT $gate_commit"
    echo "### DIRTY  $gate_dirty"
    if [ -n "$gate_status_list" ]; then
      # sed reads all of its input, so a long dirty list cannot SIGPIPE this
      # block the way head does under pipefail/set -e (exit 141, silent abort
      # before the runner launches and before the pointer is updated).
      printf '%s\n' "$gate_status_list" | sed -n '1,50s/^/### + /p'
      if [ "$gate_dirty_total" -gt 50 ]; then
        echo "### + ... and $((gate_dirty_total - 50)) more"
      fi
    fi
    echo "### FINGERPRINT $gate_fingerprint"
    echo "### TOOLCHAIN node $gate_node pnpm $gate_pnpm"
    echo "### POSTGRES $gate_postgres"
    echo "### GATE_CONTAINER $LAUNCH_CONTAINER (image $GATE_IMAGE, 127.0.0.1:$LAUNCH_PORT, shm $GATE_SHM)"
    echo "### DB     $gatedb (container $LAUNCH_CONTAINER 127.0.0.1:$LAUNCH_PORT)"
    echo "### START  $(date -Is)"
    echo
  } >>"$log"

  # Exported, not inline — see the header note. Points at the throwaway
  # server, never at the shared dev database. The explicit *_DATABASE_URLs
  # are required: urls.ts refuses to synthesize default-credentialed URLs
  # against a non-default host/port (#1383), and this server is always both.
  # Role passwords match the dev defaults in packages/db/src/urls.ts.
  # Both name spells are exported: resolveMossEnv prefers MOSS_* over
  # JARVIS_*, so a caller with MOSS_* pointed at the shared dev database
  # would otherwise split the gate across two servers.
  export JARVIS_PGHOST="$GATE_DBHOST"
  export JARVIS_PGPORT="$LAUNCH_PORT"
  export JARVIS_PGDATABASE="$gatedb"
  export JARVIS_BOOTSTRAP_DATABASE_URL="postgres://postgres:postgres@${GATE_DBHOST}:${LAUNCH_PORT}/${gatedb}"
  export JARVIS_MIGRATION_DATABASE_URL="postgres://jarvis_migration_owner:migration_password@${GATE_DBHOST}:${LAUNCH_PORT}/${gatedb}"
  export JARVIS_APP_DATABASE_URL="postgres://jarvis_app_runtime:app_password@${GATE_DBHOST}:${LAUNCH_PORT}/${gatedb}"
  export JARVIS_AUTH_DATABASE_URL="postgres://jarvis_auth_runtime:auth_password@${GATE_DBHOST}:${LAUNCH_PORT}/${gatedb}"
  export JARVIS_WORKER_DATABASE_URL="postgres://jarvis_worker_runtime:worker_password@${GATE_DBHOST}:${LAUNCH_PORT}/${gatedb}"
  export MOSS_PGHOST="$JARVIS_PGHOST"
  export MOSS_PGPORT="$JARVIS_PGPORT"
  export MOSS_PGDATABASE="$JARVIS_PGDATABASE"
  export MOSS_BOOTSTRAP_DATABASE_URL="$JARVIS_BOOTSTRAP_DATABASE_URL"
  export MOSS_MIGRATION_DATABASE_URL="$JARVIS_MIGRATION_DATABASE_URL"
  export MOSS_APP_DATABASE_URL="$JARVIS_APP_DATABASE_URL"
  export MOSS_AUTH_DATABASE_URL="$JARVIS_AUTH_DATABASE_URL"
  export MOSS_WORKER_DATABASE_URL="$JARVIS_WORKER_DATABASE_URL"
  # Run marker for the database backstop: the integration-test resets, the
  # test-integration wrapper, and the UAT seed connections refuse to open a
  # database without it (or the documented override). scripts/migrate.ts is
  # deliberately not guarded — compose smokes run it inside images that
  # never see this marker. Both spells, like the URLs above.
  export JARVIS_GATE_RUN=1
  export MOSS_GATE_RUN=1

  # setsid+nohup so the run outlives this shell. The Bash tool's shell exits the
  # moment the call returns; without full detachment the gate can die with it.
  # stdin comes from nowhere so nohup never prints its "ignoring input"
  # notice. The launcher's stderr goes to a sidecar so a real failure becomes
  # the DEAD reason instead of a generic message.
  setsid nohup "$0" __run "$log" "$gate" "$keep_db" "$gatedb" "$exclusive" "$root" "$LAUNCH_CONTAINER" \
    </dev/null >/dev/null 2>"$log.launch-err" &
  local launcher_pid=$!
  disown 2>/dev/null || true

  # Launch confirmation (#2473). The runner records `### PID` as its first log
  # action, within about a second of a healthy launch. If no PID lands within
  # the bound, the launch itself failed: stop the orphan before it can hold
  # the gate database (or the shared lock under --exclusive), mark the log so
  # every later status/wait reports DEAD with the reason, and fail this start
  # loudly instead of returning success.
  local waited=0
  while [ "$waited" -lt "$LAUNCH_WAIT_SECS" ]; do
    if grep -q '^### PID ' "$log" 2>/dev/null; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # The error sidecar is pruned when empty so healthy runs leave no clutter;
  # a real error stays for the DEAD reason below.
  [ -s "$log.launch-err" ] || rm -f "$log.launch-err" 2>/dev/null || true
  if ! grep -q '^### PID ' "$log" 2>/dev/null; then
    # Group-kill only when the launcher leads its own session (what real
    # setsid creates); otherwise kill just the launcher itself.
    if [ "$(ps -o sid= -p "$launcher_pid" 2>/dev/null | tr -d ' ')" = "$launcher_pid" ]; then
      kill -TERM -- -"$launcher_pid" 2>/dev/null || kill -TERM "$launcher_pid" 2>/dev/null || true
    else
      kill -TERM "$launcher_pid" 2>/dev/null || true
    fi
    # First launcher error line, skipping only nohup's own "ignoring input"
    # notice, which would otherwise hide the real cause when stdin is a
    # terminal. Anything else nohup reports — including its own "failed to
    # run command" errors — is a real reason and must be kept.
    local launch_err=""
    launch_err="$(grep -v '^nohup: ignoring input' "$log.launch-err" 2>/dev/null || true)"
    launch_err="${launch_err%%$'\n'*}"
    launch_err="${launch_err:0:200}"
    [ -n "$launch_err" ] || launch_err="runner never recorded its PID within ${LAUNCH_WAIT_SECS}s of launch"
    echo "${LAUNCH_FAILED_PREFIX}${launch_err} ($(date -Is))" >>"$log"
    remove_gate_container "$LAUNCH_CONTAINER"
    echo "### CLEANUP removed gate container $LAUNCH_CONTAINER (launch failed)" >>"$log"
    LAUNCH_CONTAINER=""
    LAUNCH_OK=1
    die "runner failed to start: $launch_err ($log reads DEAD, see status)"
  fi

  LAUNCH_OK=1
  trap - EXIT

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
RUN_CONTAINER=""
run_finish() {
  local rc=$?
  [ -n "$RUN_LOG" ] || exit "$rc"
  # The database dies with its server: the container goes on every ending —
  # pass, fail, or signal — and --keep-db keeps nothing behind.
  if [ -n "${RUN_CONTAINER:-}" ]; then
    docker rm -f "$RUN_CONTAINER" >/dev/null 2>&1 || true
    echo "### CLEANUP removed gate container $RUN_CONTAINER (rc=$rc)" >>"$RUN_LOG"
  else
    echo "### CLEANUP no gate container recorded (rc=$rc)" >>"$RUN_LOG"
  fi
  echo "### END    $(date -Is)" >>"$RUN_LOG"
  echo "${SENTINEL_PREFIX}${rc}" >>"$RUN_LOG"
  exit "$rc"
}

# Internal. Runs the gate with a trap-guaranteed sentinel.
cmd___run() {
  local log="$1" gate="$2" keep_db="$3" gatedb="$4" exclusive="$5" root="$6" container="${7:-}"

  # These MUST be globals, not locals. An EXIT trap runs after the calling
  # function's frame has already unwound, so `local` values are gone by the time
  # it fires — and under `set -u` the trap then dies on its first unbound
  # reference, writing no sentinel at all. That is exactly the failure this
  # script exists to prevent, and the first version of it shipped that bug.
  RUN_LOG="$log"
  RUN_KEEP_DB="$keep_db"
  RUN_GATEDB="$gatedb"
  RUN_CONTAINER="$container"

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

  # --exclusive is accepted for compatibility but no longer serializes
  # anything: each run owns its server, so concurrent gates never contend.
  #
  # Migrate first, then gate (#2989 follow-up). The throwaway server starts
  # empty and the bootstrap deliberately creates roles WITHOUT passwords, so
  # only `db:migrate` (applyRolePasswords) makes role logins work. A narrowed
  # gate without a prior migrate would fail every database login on a fresh
  # server — on the old shared server this was invisible because passwords
  # persisted. Migrate is idempotent, so full gates just re-confirm.
  # A failed migrate fails the run with its own errors in the log.
  pnpm db:migrate >>"$log" 2>&1 && pnpm "$gate" >>"$log" 2>&1
}

# ---------------------------------------------------------------------------
# status / wait
# ---------------------------------------------------------------------------

# One-line receipt for status output (#2462): which commit was tested,
# whether the tree was dirty, the input fingerprint, and the toolchain.
# Logs written before each recording report that field as unknown. The
# full reuse rule lives in the verify-gate skill: changed or unknown
# inputs invalidate reuse.
receipt_summary() {
  local log="$1" commit dirty fp fp_short tool
  commit="$(grep -m 1 '^### COMMIT ' "$log" | awk '{print $3}' || true)"
  dirty="$(grep -m 1 '^### DIRTY ' "$log" | sed 's/^### DIRTY  //' || true)"
  fp="$(grep -m 1 '^### FINGERPRINT ' "$log" | awk '{print $3}' || true)"
  tool="$(grep -m 1 '^### TOOLCHAIN ' "$log" | sed 's/^### TOOLCHAIN //' || true)"
  [ -n "$commit" ] || commit="unknown (predates commit recording)"
  [ -n "$dirty" ] || dirty="unknown (predates commit recording)"
  case "$fp" in
    sha256:*) fp_short="$(printf '%s' "$fp" | sed 's/^sha256://' | cut -c1-12)" ;;
    *) fp_short="unknown" ;;
  esac
  [ -n "$tool" ] || tool="unknown (predates toolchain recording)"
  echo "commit $commit, tree $dirty, inputs $fp_short, tool $tool"
}

# Prints a human line; returns one of the shared exit codes.
verdict() {
  local log="$1" quiet="${2:-0}"
  [ -f "$log" ] || die "no such log: $log"

  local sentinel rc receipt
  receipt="$(receipt_summary "$log")"
  sentinel="$(grep -F "$SENTINEL_PREFIX" "$log" | tail -1 || true)"
  if [ -n "$sentinel" ]; then
    rc="${sentinel##"$SENTINEL_PREFIX"}"
    [ "$quiet" = "1" ] || echo "DONE rc=$rc  ($log)  [$receipt]"
    [ "$rc" = "0" ] && return 0
    return 1
  fi

  # Failed launch (#2473). Terminal only when the runner never recorded a
  # PID: a late runner that kept going must still read by liveness below, and
  # a finished run already returned above — a stale marker must never override
  # either. A launch failure with no runner behind it is DEAD at once, never
  # a silent RUNNING until the idle bound.
  local launch_failure
  launch_failure="$(grep -F "$LAUNCH_FAILED_PREFIX" "$log" | tail -1 || true)"
  if [ -n "$launch_failure" ] && ! grep -q '^### PID ' "$log" 2>/dev/null; then
    [ "$quiet" = "1" ] || {
      echo "DEAD  ${launch_failure#"${LAUNCH_FAILED_PREFIX}"}  ($log)  [$receipt]"
      echo "last: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 2
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
      echo "RUNNING  pid $pid alive, last write ${age}s ago  ($log)  [$receipt]"
      echo "at: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 3
  fi

  if [ "$alive" = "no" ]; then
    # Process gone and no sentinel: killed hard enough to skip the trap
    # (SIGKILL, OOM, host reboot). Terminal, regardless of mtime.
    [ "$quiet" = "1" ] || {
      echo "DEAD  pid $pid gone with no sentinel (log idle ${age}s)  ($log)  [$receipt]"
      echo "last: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 2
  fi

  # No recorded PID. If the log carries our first header line, the runner
  # should have recorded its PID within seconds of launch — an older
  # header-only log means the start died before the runner existed (#2473),
  # so report DEAD after the short launch grace instead of the foreign-log
  # idle bound. Key on the FIRST line: ### START is written last, and a start
  # killed mid-setup may never reach it. Only a log with no header at all is
  # a hand-rolled or foreign log, judged by mtime alone.
  if grep -q '^### GATE ' "$log" 2>/dev/null; then
    if [ "$age" -gt "$LAUNCH_GRACE_SECS" ]; then
      [ "$quiet" = "1" ] || {
        echo "DEAD  start header present but the runner never recorded a pid (log idle ${age}s, launch grace ${LAUNCH_GRACE_SECS}s) — the start failed before the runner launched  ($log)  [$receipt]"
        echo "last: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
      }
      return 2
    fi
  elif [ "$age" -gt "$STALE_SECS" ]; then
    [ "$quiet" = "1" ] || {
      echo "DEAD  no sentinel, no recorded pid, log idle ${age}s (bound ${STALE_SECS}s)  ($log)  [$receipt]"
      echo "last: $(grep -v '^[[:space:]]*$' "$log" | tail -1 | cut -c1-160)"
    }
    return 2
  fi

  [ "$quiet" = "1" ] || {
    echo "RUNNING  last write ${age}s ago  ($log)  [$receipt]"
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

  # Nothing to stop when the runner never launched (a launch-failed log):
  # report the verdict instead of erroring, mirroring the finished-run path.
  # The server is already gone on this path (launch failure removes it), but
  # ask again: a SIGKILLed start can leave one behind with no marker at all.
  if ! grep -q '^### PID ' "$log" 2>/dev/null; then
    remove_log_container "$log"
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
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || {
    # Already gone without a sentinel (SIGKILL, OOM): its trap never ran, so
    # its server is still up. Remove it here; the next start's sweep is the
    # backstop when even stop never runs.
    remove_log_container "$log"
    die "could not signal pid $pid (already gone?)"
  }

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
