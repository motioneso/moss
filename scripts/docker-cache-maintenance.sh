#!/usr/bin/env bash
# docker-cache-maintenance.sh — conservative BuildKit cache pruning for recurring
# host maintenance.
#
# WHY THIS EXISTS (2026-08-13 incident)
#
# The host reached 98% disk usage during a full verification gate. Docker
# reported ~99.8GB of BuildKit cache (97.68GB reclaimable). A one-time
# coordinator cleanup removed only cache older than 24h (after an initial
# 7-day pass) and recovered ~95GB. Containers, images, and volumes were
# intentionally left untouched.
#
# SCOPE: BuildKit build cache only. This script never runs `docker system
# prune`, `docker image prune`, or `docker volume prune`.
#
# USAGE
#   scripts/docker-cache-maintenance.sh [--dry-run]
#
# Not wired to a scheduler by this change — a systemd timer/cron can call it
# later; the lock below already makes that safe.
#
# ENVIRONMENT OVERRIDES
#   JARVIS_DOCKER_CACHE_BUILDERS         space-separated builder names to
#                                        target (default: "default
#                                        jarvisbuilder multiarch"). A builder
#                                        that doesn't exist on this host is
#                                        skipped, not an error.
#   JARVIS_DOCKER_CACHE_MAX_AGE          buildx prune `until` filter duration
#                                        (default: 168h — 7 days). This is a
#                                        conservative recurring default, more
#                                        cautious than the 24h emergency pass
#                                        used during the incident.
#   JARVIS_DOCKER_CACHE_MAX_USED_SPACE   optional buildx prune
#                                        `--max-used-space` value (e.g.
#                                        "50GB"). Unset by default — only the
#                                        age filter applies unless set.
#   JARVIS_DOCKER_CACHE_LOCK_DIR         this script's own lock directory
#                                        (default: /tmp/jarv1s-docker-cache-maintenance)
#   JARVIS_GATE_DIR                     gate lock/log directory, shared with
#                                        scripts/run-gate.sh (default:
#                                        /tmp/jarv1s-gate). Used read-only
#                                        here to detect a live gate.
#
# LOCKING
#   1. Self-lock: a non-blocking flock on
#      $JARVIS_DOCKER_CACHE_LOCK_DIR/run.lock. A second concurrent run of this
#      script exits 0 immediately rather than racing the first.
#   2. Gate lock: a non-blocking flock on $JARVIS_GATE_DIR/db.lock, the same
#      file scripts/run-gate.sh serializes gate runs on. If a gate holds it,
#      this script skips the run (exit 0) instead of waiting — a timer should
#      just retry on its next cycle. If we acquire it first, we hold it for
#      the whole prune run, so a gate that starts afterward blocks on its own
#      flock until we finish, rather than racing us.
#
# EXIT CODES
#   0  completed (including a no-op skip: locked, or no builders present)
#   1  a builder's `docker buildx prune` actually failed
set -euo pipefail

BUILDERS="${JARVIS_DOCKER_CACHE_BUILDERS:-default jarvisbuilder multiarch}"
MAX_AGE="${JARVIS_DOCKER_CACHE_MAX_AGE:-168h}"
MAX_USED_SPACE="${JARVIS_DOCKER_CACHE_MAX_USED_SPACE:-}"
LOCK_DIR="${JARVIS_DOCKER_CACHE_LOCK_DIR:-/tmp/jarv1s-docker-cache-maintenance}"
GATE_DIR="${JARVIS_GATE_DIR:-/tmp/jarv1s-gate}"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  echo "docker-cache-maintenance: unknown argument '$1' (only --dry-run is supported)" >&2
  exit 4
fi

# ── locking ──────────────────────────────────────────────────────────────────

mkdir -p "$LOCK_DIR"
exec 9>"$LOCK_DIR/run.lock"
if ! flock -n 9; then
  echo "docker-cache-maintenance: another run already holds $LOCK_DIR/run.lock — exiting"
  exit 0
fi

mkdir -p "$GATE_DIR"
exec 8>"$GATE_DIR/db.lock"
if ! flock -n 8; then
  echo "docker-cache-maintenance: gate lock $GATE_DIR/db.lock is held — a gate is running, skipping this run"
  exit 0
fi
# fd 8 stays open (and locked) for the rest of the script, so a gate that
# starts while we're pruning blocks on its own flock until we're done.

# ── prune ────────────────────────────────────────────────────────────────────

echo "=== docker-cache-maintenance starting: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "builders=[$BUILDERS] max_age=$MAX_AGE max_used_space=${MAX_USED_SPACE:-<unset>} dry_run=$DRY_RUN"

overall_rc=0

for builder in $BUILDERS; do
  if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
    echo "-- builder '$builder': not present, skipping"
    continue
  fi

  args=(buildx prune --builder "$builder" --force --filter "until=${MAX_AGE}")
  [[ -n "$MAX_USED_SPACE" ]] && args+=(--max-used-space "$MAX_USED_SPACE")

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "-- builder '$builder': [dry-run] docker ${args[*]}"
    continue
  fi

  echo "-- builder '$builder': pruning..."
  if docker "${args[@]}"; then
    echo "-- builder '$builder': prune OK"
  else
    echo "-- builder '$builder': prune FAILED" >&2
    overall_rc=1
  fi
done

echo "=== docker-cache-maintenance done: $(date -u +%Y-%m-%dT%H:%M:%SZ), rc=$overall_rc ==="
exit "$overall_rc"
