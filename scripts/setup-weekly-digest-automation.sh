#!/usr/bin/env bash
set -euo pipefail

# Installs a local Friday 06:00 Pacific cron entry that writes and publishes the Moss weekly
# digest.
#
# The agent writes words only. This wrapper turns them into the page, commits it to the gh-pages
# branch, and asks GitHub to deploy. Nothing is pushed to main: a branch rule refuses direct
# pushes there, which is what silently broke the previous version of this job.

# The repository is used as a source of git objects only. All work happens in temporary
# worktrees, so it does not matter which branch anyone has checked out there, and the cron entry
# reads this script from the main branch rather than from whatever is in the working files.
REPO_ROOT="${MOSS_DIGEST_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPT_PATH="$REPO_ROOT/scripts/$(basename -- "${BASH_SOURCE[0]}")"
MARKER="# jarv1s-weekly-digest-automation"
LOG_FILE="$REPO_ROOT/.git/weekly-digest-automation.log"
PAGES_BRANCH="gh-pages"
RENDERER="tools/weekly-digest/render.mjs"

prompt() {
  cat <<'PROMPT'
Review every pull request merged in this GitHub repository since the previous Friday at 06:00
America/Los_Angeles. Then write this week's Moss weekly digest.

Write the digest as JSON to the output file named at the end of this message. Write nothing else: do not edit any file in the repository, do not commit, do not push. The shape is:

{
  "summary": "one sentence, used as the page description in search results and link previews",
  "intro": "two or three sentences of warm, plain-English introduction to the week",
  "headline": {
    "title": "the single most interesting thing that shipped",
    "body": ["one or two paragraphs about it"],
    "prs": [1804]
  },
  "sections": [
    { "title": "New",      "items": [ { "title": "...", "body": "...", "prs": [1716, 1788] } ] },
    { "title": "Improved", "items": [ { "title": "...", "body": "...", "prs": [1703] } ] }
  ],
  "fixes": [ { "text": "one sentence, what the user notices", "prs": [1810] } ]
}

There is a worked example at tools/weekly-digest/example-content.json. Match its voice: editorial,
concise, warm, slightly playful, written for someone who does not read code.

Rules:
- Call the product "Moss" everywhere. Never write "Jarv1s" or "Jarvis" in the digest.
- Describe what a person can now do, not how it was built. No file paths, class names, or internal
  jargon.
- Every entry links the pull requests it came from.
- Only merged pull requests inside the window. No duplicates, no claims the pull request itself
  does not support.
- Leave out anything invisible to a user: test changes, refactors, CI work, dependency bumps.
- Pick exactly one headline story. If the week was quiet, say so plainly rather than inflating it.
- Do not invent an issue number or a date; those get filled in for you.
- If no user-facing pull requests merged in the window, write nothing at all and exit.
PROMPT
}

run_digest() {
  for tool in codex git gh node; do
    command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
  done

  cd "$REPO_ROOT"
  local default_branch repo_name work pages content agent friday
  cleanup() {
    for dir in "${work:-}" "${pages:-}"; do
      [[ -n "$dir" ]] && git -C "$REPO_ROOT" worktree remove --force "$dir" >/dev/null 2>&1 || true
    done
    rm -f "${agent:-}" "${content:-}" "${last_message:-}"
  }
  trap cleanup EXIT

  default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
  repo_name="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
  friday="$(TZ=America/Los_Angeles date -d 'last friday' +%F)"
  if [[ "$(TZ=America/Los_Angeles date +%u)" == "5" ]]; then
    friday="$(TZ=America/Los_Angeles date +%F)"
  fi

  work="$(mktemp -d "${TMPDIR:-/tmp}/moss-weekly-work.XXXXXX")"
  pages="$(mktemp -d "${TMPDIR:-/tmp}/moss-weekly-pages.XXXXXX")"
  agent="$(mktemp "${TMPDIR:-/tmp}/moss-weekly-agent.XXXXXX.json")"
  content="$(mktemp "${TMPDIR:-/tmp}/moss-weekly-content.XXXXXX.json")"
  last_message="$(mktemp "${TMPDIR:-/tmp}/moss-weekly-message.XXXXXX")"

  git fetch origin "$default_branch" --quiet
  rmdir "$work" "$pages"
  git worktree add --detach "$work" "origin/$default_branch" --quiet

  # The published site lives on its own branch, unguarded by any ruleset.
  if git ls-remote --exit-code --heads origin "$PAGES_BRANCH" >/dev/null 2>&1; then
    git fetch origin "$PAGES_BRANCH" --quiet
    git worktree add "$pages" --quiet -B "$PAGES_BRANCH" "origin/$PAGES_BRANCH"
  else
    git worktree add --orphan -b "$PAGES_BRANCH" "$pages" --quiet
    echo "Created the $PAGES_BRANCH branch" | tee -a "$LOG_FILE"
  fi

  : >"$agent"
  { prompt; printf '\nOutput file: %s\n' "$agent"; } | codex exec \
    --cd "$work" \
    --dangerously-bypass-approvals-and-sandbox \
    --ephemeral \
    -o "$last_message" \
    -

  if [[ ! -s "$agent" ]]; then
    echo "No digest written: quiet week, or the agent produced nothing" | tee -a "$LOG_FILE"
    exit 0
  fi
  if [[ -n "$(git -C "$work" status --porcelain --untracked-files=all)" ]]; then
    echo "Stopped: the agent changed repository files, which it must not do" | tee -a "$LOG_FILE"
    exit 1
  fi

  node "$work/$RENDERER" --stamp "$agent" --archive-dir "$pages/archive" --friday "$friday" >"$content"
  node "$work/$RENDERER" "$content" --out "$pages"

  git -C "$pages" add --all .
  if git -C "$pages" diff --cached --quiet; then
    echo "Digest is already published and unchanged" | tee -a "$LOG_FILE"
    exit 0
  fi
  git -C "$pages" -c user.name="weekly-digest" -c user.email="weekly-digest@users.noreply.github.com" \
    commit --quiet -m "Publish Moss weekly digest for $friday"
  git -C "$pages" push --quiet origin "$PAGES_BRANCH"
  gh workflow run publish-weekly-digest.yml --repo "$repo_name" --ref "$default_branch"
  echo "Published the digest for $friday and asked GitHub Pages to deploy" | tee -a "$LOG_FILE"
} >>"$LOG_FILE" 2>&1

install_cron() {
  command -v crontab >/dev/null || {
    echo "crontab is required; this installer targets Unix cron." >&2
    exit 1
  }

  local current entry temp=""
  current="$(crontab -l 2>/dev/null || true)"
  if grep -Fq "$MARKER" <<<"$current"; then
    echo "Weekly digest automation is already installed."
    exit 0
  fi

  # cron runs /bin/sh, which cannot read a script from a pipe, so the line asks for bash.
  entry="$MARKER
CRON_TZ=America/Los_Angeles
0 6 * * 5 bash -lc 'cd $REPO_ROOT && git fetch -q origin main && MOSS_DIGEST_REPO=$REPO_ROOT bash <(git show origin/main:scripts/setup-weekly-digest-automation.sh) --run'"
  temp="$(mktemp)"
  trap 'rm -f "${temp:-}"' EXIT
  {
    printf '%s\n' "$current"
    printf '%s\n' "$entry"
  } >"$temp"
  crontab "$temp"
  echo "Installed: every Friday at 06:00 America/Los_Angeles"
  echo "Log: $LOG_FILE"
}

case "${1:-install}" in
  --run) run_digest ;;
  --install|install) install_cron ;;
  --uninstall|uninstall)
    current="$(crontab -l 2>/dev/null || true)"
    crontab - <<<"$(awk -v marker="$MARKER" 'index($0, marker) == 0 && $0 != "CRON_TZ=America/Los_Angeles" && $0 !~ /setup-weekly-digest-automation\.sh.* --run$/ { print }' <<<"$current")"
    echo "Removed weekly digest automation."
    ;;
  --status|status)
    crontab -l 2>/dev/null | grep -F -A1 "$MARKER" || echo "Not installed."
    ;;
  *)
    echo "Usage: $SCRIPT_PATH [install|--run|uninstall|status]" >&2
    exit 2
    ;;
esac
