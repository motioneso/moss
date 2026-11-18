# Shared helpers for the Phase 1 Linux proofs. Source it; never run it.
#
#   MOSS_SPIKE_SCRATCH  scratch folder for the bundle, the installs and the logs (required)
#   PG                  Postgres bundle to run (default: the one build-pg.sh makes)
#   MOSS_DB             the moss-db program (default: the debug build in the cargo target folder)

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
B=${MOSS_SPIKE_SCRATCH:?set MOSS_SPIKE_SCRATCH to a scratch folder}
BIN=${MOSS_DB:-${CARGO_TARGET_DIR:-$REPO/rust-spike/target}/debug/moss-db}
PG=${PG:-$B/pg/17.11-linux-x86_64}
RUNS=$B/runs

# up_bg ROOT LOG [args...]: start a supervisor detached; prints its pid.
up_bg() {
  local root=$1 log=$2; shift 2
  setsid nohup "$BIN" up --root "$root" --pg "$PG" --repo "$REPO" "$@" >"$log" 2>&1 < /dev/null &
  echo $!
}

# wait_event LOG EVENT [SECONDS]: wait until LOG has a line with that event.
wait_event() {
  local log=$1 event=$2 limit=${3:-120} i=0
  until grep -q "\"event\":\"$event\"" "$log" 2>/dev/null; do
    i=$((i+1)); [ $i -gt $((limit*10)) ] && { echo "TIMEOUT waiting for $event in $log"; return 1; }
    if grep -q '"event":"error"' "$log" 2>/dev/null; then echo "ERROR in $log"; cat "$log"; return 1; fi
    sleep 0.1
  done
}
