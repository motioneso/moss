# #1533 chat surface build — relay15 handoff

Supersedes relay14. Branch `build/1533-chat-surface-routing`, HEAD `d93addd6f` (merge commit,
`origin/main` @ `8b2a4b357` confirmed ancestor).

## State

- Phase 3: DONE. Phase 4 gate: DONE (green `80f01f537`, pre-merge — **must re-run post-merge,
  do not trust it as still valid**). Sensitive-tier check: DONE (clean pre-merge; re-diff
  post-merge as a sanity check, should still be exactly this branch's own files).
- **Merge landed this relay** — someone (Ben or a granted session) ran it directly; my own
  `git merge origin/main --no-edit` after Ben said "back to approve here" returned "Already up
  to date", confirming it was already done. `tests/uat/fixtures/scripted-provider/` verified
  present on disk (`ls`, not `git show`).
- Live-path proof: NOT YET ATTEMPTED with the now-available files. This is the next concrete
  step, fully scoped already (see relay12/relay13/relay14 for the full mechanism — do not
  re-derive, just execute).
- Draft PR: not opened.

## Next (pick up here, in a fresh session — this one is checkpointing at 70% context)

1. Re-run full gate (`scripts/run-gate.sh`, fresh gate DB) post-merge — do not reuse
   `80f01f537`'s result.
2. Re-confirm sensitive-tier diff post-merge (`git diff --name-only origin/main...HEAD`).
3. Live-path proof: tool = `job-search.criteria.set` (schema `jarvis.module.json:77-147`,
   requires `profileId` + `criteria` object). Chat-script contract at
   `tests/uat/fixtures/scripted-provider/script-schema.ts`. Wiring: `uatLevel.chatScript` →
   `JARVIS_UAT_SEED_CHAT_SCRIPT` → `tests/uat/seed/chunks/chat-script.ts`. Procedure: spec doc
   `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` lines 296-319 (7
   steps — read fresh). Given browser-automation scope, dispatch to a fork
   (`subagent_type: "fork"`) rather than doing inline, same as the prior two attempts — brief it
   with exactly this file list, don't let it re-derive.
4. Once real evidence exists (network + screenshot + teardown, no fake/approximate): draft PR
   via `coordinated-wrap-up`, not merge.

## Standing instructions (unchanged)

- Coordinator: re-resolve fresh via `herdr agent list`, `herdr agent prompt <fresh-name> "..."`.
  Last known: `coord-relay9` at `w1:p7P` — re-resolve, don't trust.
- `needs-ben <name> "<question>"` + background `until`-loop watch on `~/.needs-ben/replies/` —
  never poll in-context. Lesson from this relay: a needs-ben "approve" is a decision-gate
  answer, not a tool-permission grant for blocked Bash actions — only a live interactive
  session (human present, as happened this relay) or the human running it directly unblocks
  those.
- `scripts/run-gate.sh`, never bare `pnpm verify:foundation`.
- Shared-checkout discipline: explicit-path commits, `git show --name-only HEAD` verify after
  every commit, check `herdr pane list` for sibling sessions in this worktree before any
  tree-wide git action.
- Relay again at next 70% warning or on compaction.
