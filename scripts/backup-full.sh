#!/usr/bin/env bash
# Jarv1s full backup: Postgres DB dump + Obsidian vault → timestamped tar.gz
# DB dump via docker exec (pg_dump version matches server; credentials stay in container).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
ARCHIVE_DIR="${JARVIS_BACKUP_DIR:-$REPO_DIR/backups}"
VAULT_DIR="${JARVIS_VAULT_DIR:-$HOME/obsidian-vault}"
DAILY_KEEP="${JARVIS_BACKUP_DAILY_KEEP:-7}"
WEEKLY_KEEP="${JARVIS_BACKUP_WEEKLY_KEEP:-4}"
OFFHOST_CMD="${JARVIS_BACKUP_OFFHOST_CMD:-}"
PG_CONTAINER="${JARVIS_BACKUP_PG_CONTAINER:-jarv1s-postgres}"
PG_DATABASE="${JARVIS_PGDATABASE:-jarv1s}"

STAGING="$(mktemp -d)"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

# ── internal functions (callable by test harness via source) ─────────────────

_prune_archives() {
  local archive_dir="$1"
  local daily_keep="$2"
  local weekly_keep="$3"

  local archives=()
  while IFS= read -r fname; do
    archives+=("$fname")
  done < <(find "$archive_dir" -maxdepth 1 \
    \( -name 'jarv1s-*.tar.gz' -o -name 'moss-*.tar.gz' \) \
    -printf '%f\n' 2>/dev/null | sort -r)

  [[ ${#archives[@]} -eq 0 ]] && return 0

  local now_epoch
  now_epoch=$(date -u +%s)
  local daily_cutoff=$(( now_epoch - daily_keep * 86400 ))
  local weekly_cutoff=$(( now_epoch - (daily_keep + weekly_keep * 7) * 86400 ))

  declare -A keep_set
  declare -A kept_weeks

  for fname in "${archives[@]}"; do
    # Strip whichever prefix matched — pre-cutover archives still carry jarv1s-,
    # archives written after #1444 carry moss-. Only one strip is ever a no-op.
    local ts_raw="${fname#jarv1s-}"
    ts_raw="${ts_raw#moss-}"
    ts_raw="${ts_raw%.tar.gz}"
    # YYYY-MM-DDTHH-MM-SSZ → YYYY-MM-DDTHH:MM:SSZ
    local ts_iso="${ts_raw:0:13}:${ts_raw:14:2}:${ts_raw:17:2}Z"
    local file_epoch
    file_epoch=$(date -u -d "$ts_iso" +%s 2>/dev/null) || continue

    if (( file_epoch >= daily_cutoff )); then
      keep_set["$fname"]=1
    elif (( file_epoch >= weekly_cutoff )); then
      local week_key
      week_key=$(date -u -d "@${file_epoch}" +%G-W%V)
      if [[ -z "${kept_weeks[$week_key]+x}" ]]; then
        kept_weeks["$week_key"]=1
        keep_set["$fname"]=1
      fi
    fi
  done

  for fname in "${archives[@]}"; do
    if [[ -z "${keep_set[$fname]+x}" ]]; then
      echo "Pruning old archive: $archive_dir/$fname"
      rm -f "$archive_dir/$fname"
    fi
  done
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  echo "=== Jarv1s backup starting: $TIMESTAMP ==="

  BUNDLE_DIR="$STAGING/moss-$TIMESTAMP"
  mkdir -p "$BUNDLE_DIR"

  # 1. DB dump — PGPASSWORD sourced from container's POSTGRES_PASSWORD; never on host cmdline
  echo "Dumping database '$PG_DATABASE' from container '$PG_CONTAINER'..."
  docker exec \
    -e BACKUP_DBNAME="$PG_DATABASE" \
    "$PG_CONTAINER" \
    bash -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
      --username=postgres \
      --dbname="$BACKUP_DBNAME" \
      -Fc' \
    > "$BUNDLE_DIR/db.dump"

  # 2. Vault snapshot
  if [[ -d "$VAULT_DIR" ]]; then
    echo "Snapshotting vault: $VAULT_DIR"
    rsync -a --delete "$VAULT_DIR/" "$BUNDLE_DIR/vault/"
  else
    echo "WARNING: vault dir not found: $VAULT_DIR — skipping vault snapshot"
    mkdir -p "$BUNDLE_DIR/vault"
  fi

  # 3. Bundle into archive (write to tmp then mv — avoids partial .tar.gz in archive dir)
  mkdir -p "$ARCHIVE_DIR"
  ARCHIVE="$ARCHIVE_DIR/moss-$TIMESTAMP.tar.gz"
  ARCHIVE_TMP="$STAGING/moss-$TIMESTAMP.tar.gz"
  echo "Bundling archive: $ARCHIVE"
  tar -czf "$ARCHIVE_TMP" -C "$STAGING" "moss-$TIMESTAMP"
  mv "$ARCHIVE_TMP" "$ARCHIVE"

  # 4. Retention pruning
  echo "Pruning archives (daily_keep=$DAILY_KEEP, weekly_keep=$WEEKLY_KEEP)..."
  _prune_archives "$ARCHIVE_DIR" "$DAILY_KEEP" "$WEEKLY_KEEP"

  # 5. Off-host copy
  if [[ -n "$OFFHOST_CMD" ]]; then
    echo "Running off-host copy..."
    eval "${OFFHOST_CMD/\{\}/$ARCHIVE}"
  fi

  echo "=== Backup complete: $ARCHIVE ==="
}

# Only run main if directly executed (not sourced by test harness)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main
fi
