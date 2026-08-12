# #1533 chat surface build — relay14 handoff

Supersedes relay13. Same worktree/branch: `build/1533-chat-surface-routing`, HEAD `3688d8093`
(unchanged — merge did not complete this relay).

## State

- Phase 3: DONE. Phase 4 gate: DONE (green `80f01f537`). Sensitive-tier check: DONE (clean).
- Phase 4 live-path proof: still not executed. Root cause identified precisely by the
  `livepath-1533-attempt2` fork (commit `3688d8093`, relay13): this branch forked from
  `origin/main` at `abfe0478b` and was never merged/rebased since #1121 landed at `8b2a4b357`
  — the scripted-provider/chat-script files genuinely don't exist in this checkout (the
  parent relay's earlier recon read them via `git show <sha>:<path>`, which reads git objects
  regardless of reachability from HEAD — accurate about content, silent about checkout state).
  Fix is a routine `git merge origin/main` (verified clean, 0 conflicts via `merge-tree`, no
  sibling herdr sessions in this worktree).
- **New this relay:** the merge itself is blocked by the Claude Code auto-mode permission
  classifier in this headless/background session (`git merge` denied, `find`/`ls`/`command -v`
  on some paths also denied intermittently — plain `git status/log/fetch`, `echo`, `cat` all
  work fine). Paged Ben via `needs-ben` — he replied "approve" (queued reply
  `1786472945669485123.msg`), but re-attempting the merge hit the identical classifier denial.
  **A needs-ben "approve" is a decision-gate answer, not a tool-permission grant** — this
  classifier requires either Ben running the merge himself, a live interactive session where he
  can click-approve the Bash prompt, or a permission-settings rule. Sent a clarifying follow-up
  via `needs-ben` (queued `1786473731960124051.msg`) explaining this distinction and the three
  options. Standing by for that reply now — not retrying the same merge a third time
  (box-wide rule: two identical failures → stop and rethink, which this relay did).
- Draft PR: not opened, still gated on live-path evidence.

## Next

1. Once `origin/main` is actually merged into this branch (by whichever path Ben picks), verify
   `tests/uat/fixtures/scripted-provider/`, `tests/uat/seed/chunks/chat-script.ts`,
   `tests/uat/fixtures/chat-scripts/` exist in the working tree (`ls`, not `git show`), then
   redispatch the live-path proof exactly as relay12/relay13 describe:
   tool = `job-search.criteria.set` (schema at `jarvis.module.json:77-147`, requires
   `profileId` + `criteria` object), chat-script contract at
   `tests/uat/fixtures/scripted-provider/script-schema.ts`, wiring via
   `uatLevel.chatScript` → `JARVIS_UAT_SEED_CHAT_SCRIPT`, procedure at spec doc lines 296-319.
2. Re-run the full gate after the merge (new files/deps from origin/main) before trusting
   `80f01f537`'s green as still valid post-merge — a merge can change what verify:foundation
   sees even with no conflicts.
3. Re-check the sensitive-tier diff after the merge too (`git diff --name-only origin/main...HEAD`
   should still be exactly this branch's own files, since merging origin/main into HEAD makes
   HEAD a superset — the diff command's meaning doesn't change, just confirm no surprise).

## Standing instructions (unchanged)

- Coordinator: re-resolve fresh via `herdr agent list`/`herdr pane list`, `herdr agent prompt
  <fresh-name> "..."` (SendMessage fails on herdr-registered names). Status was last pushed to
  `coord-relay9` (pane `w1:p7P` at that time) this session — re-resolve, don't trust that.
- `needs-ben <name> "<question>"` then watch `~/.needs-ben/replies/*<name>*` via a background
  `until` loop, never poll in-context.
- `scripts/run-gate.sh`, never bare `pnpm verify:foundation`.
- Relay again at next 70% warning or on compaction.
