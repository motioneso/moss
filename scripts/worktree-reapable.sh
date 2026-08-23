#!/usr/bin/env bash
# worktree-reapable.sh — the four-gate "safe to remove?" check for a build-agent worktree.
#
# Replaces the hand-typed four-line check from the coordinate skill (2026-08-23 audit: a
# four-line /proc incantation typed from memory under context pressure was the weakest link in
# the merge path — the most consequential and most skippable step).
#
# Usage: scripts/worktree-reapable.sh <worktree-path>
# Exit:  0 = all gates clear, safe to `git worktree remove` (untracked node_modules may need --force)
#        1 = NOT safe — one or more gates failed; each failure is printed with why
#        2 = usage / not a worktree
#
# Prints one line per gate, then a final verdict line. Record the verdict line in the run
# manifest so a successor can tell a passed check from a skipped one.
set -uo pipefail

wt="${1:-}"
if [ -z "$wt" ] || [ ! -d "$wt" ]; then
  echo "usage: $0 <worktree-path> (directory not found: '$wt')" >&2
  exit 2
fi
wt="$(cd "$wt" && pwd)"
if ! git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git worktree: $wt" >&2
  exit 2
fi

fail=0

# Gate 1 — commits landed. Informational only: a squash-merged branch still shows all its
# commits, so ahead > 0 means "verify on main before removing", not "unmerged".
git -C "$wt" fetch origin main --quiet 2>/dev/null || true
ahead="$(git -C "$wt" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
if [ "$ahead" = "0" ]; then
  echo "gate1 merged        : OK (0 commits ahead of origin/main)"
else
  echo "gate1 merged        : CHECK — $ahead commit(s) ahead of origin/main (squash merges look like this; confirm the PR merged before trusting it)"
fi

# Gate 2 — no tracked modifications, and untracked source/docs is unsaved work.
tracked_mods="$(git -C "$wt" status --porcelain | grep -cv '^??' || true)"
untracked_work="$(git -C "$wt" status --porcelain | grep '^??' | awk '{print $2}' \
  | grep -vE '^(node_modules/|\.pnpm|dist/|coverage/|\.turbo/)' | head -20 || true)"
if [ "$tracked_mods" -eq 0 ]; then
  echo "gate2 clean tree    : OK (no tracked modifications)"
else
  echo "gate2 clean tree    : FAIL — $tracked_mods tracked file(s) modified/staged (unsaved work)"
  fail=1
fi
if [ -n "$untracked_work" ]; then
  echo "gate2b untracked    : FAIL — untracked source/docs present (unsaved work):"
  echo "$untracked_work" | sed 's/^/    /'
  fail=1
else
  echo "gate2b untracked    : OK (nothing beyond build artifacts)"
fi

# Gate 3 — no live process cwd'd inside the worktree.
procs=""
for p in /proc/[0-9]*; do
  cwd="$(readlink "$p/cwd" 2>/dev/null || true)"
  case "$cwd" in
    "$wt"|"$wt"/*) procs="$procs ${p#/proc/}";;
  esac
done
if [ -z "$procs" ]; then
  echo "gate3 no processes  : OK"
else
  echo "gate3 no processes  : FAIL — live process(es) cwd'd inside:$procs"
  for pid in $procs; do
    echo "    pid $pid: $(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | cut -c1-120)"
  done
  fail=1
fi

# Gate 4 — no Herdr pane cwd'd inside the worktree.
if command -v herdr >/dev/null 2>&1; then
  panes="$(herdr pane list 2>/dev/null \
    | jq -r --arg wt "$wt" '.result.panes[] | select((.cwd // "") | startswith($wt)) | "\(.pane_id) (\(.label // "unlabeled"))"' 2>/dev/null || true)"
  if [ -z "$panes" ]; then
    echo "gate4 no panes      : OK"
  else
    echo "gate4 no panes      : FAIL — Herdr pane(s) live inside: $panes"
    fail=1
  fi
else
  echo "gate4 no panes      : SKIP — herdr not on PATH (verify panes manually)"
fi

if [ "$fail" -eq 0 ]; then
  echo "VERDICT: REAPABLE $wt (gates clear; ahead=$ahead)"
  exit 0
else
  echo "VERDICT: KEEP $wt (see FAIL lines above — do not remove)"
  exit 1
fi
