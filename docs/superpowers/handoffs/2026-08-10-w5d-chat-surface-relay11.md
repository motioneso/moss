# w5d-chat-surface relay #11

Worktree: `~/Jarv1s/.claude/worktrees/w5d-chat-surface`, branch `w5d-chat-surface`, PR #1482
(#1255 + #1451). Re-resolve Coordinator fresh via `herdr agent list` — do not trust any pane id
baked into an older doc (was `w1:p42`/agent `codex` as of this writing). Full state: agentmemory
`project: jarvis`, search "PR #1482 rebase-over-#1538 complete" — **read that before redoing
anything**, it supersedes all earlier #1482 relay memories.

## Status

Rebase (blocker 3) done. Head for fresh QA: **`c2d3b69559dca743d8f3c9ff6107c731fd8f158e`**, pushed.
Rebased onto main after both #1492 and #1538 (the #1532 stale-selector fix) merged. Clean rebase,
no conflicts, `DEFAULT_CHAT_SURFACE` (#1494) confirmed untouched.

Blockers 1 (live proof) and 2 (4 mapped UATs) were already done and reported on the *previous*
head (`c1811525b`) — see PR comments `#issuecomment-5242786202` (live proof) and the UAT summary
comment. Both need to be **redone on the new head** since it moved twice since then.

## Next: redo blockers 1 and 2 on the new head, report fresh QA

1. `gh pr checks 1482` — confirm CI green on `c2d3b6955` (auto-triggered by the push; do not
   manually rerun it or touch any timeout).
2. Run the 4 mapped UATs fresh: `1089-1090-chat-drawer-private`, `1133-chat-attachments`,
   `moss-assistant-name`, `runtime-context`. Expect `1133` and `runtime-context` to now pass since
   #1538 fixed the `"Chat with Jarvis"` stale-selector residue (#1532) that failed them last time.
   `run-uat.ts` aborts the whole batch on first non-zero spec — if anything still fails, run the
   rest as a separate filtered invocation rather than assuming they didn't run.
3. Fresh live-proof: persona-pending → neutral copy, persona-resolved → custom name, no "Moss"
   flash. Same Playwright methodology as before (script pattern is in the PR comment above).
4. Post one consolidated PR comment covering all 4 UAT results + the live-proof, then report to
   Coordinator via `herdr-pane-message` for a fresh QA verdict.

Dispatch 1-3 as parallel background forks (fresh CI check + UAT fork + live-proof fork) — each is
heavy Docker/Playwright output that doesn't need to sit in the main session's context.

## Constraints (still binding)

No merge, no manual CI rerun, no CI timeout change, do not bundle #1534, keep #1533 separate.

## Protocol reminders

Shared checkout — `shared-checkout` skill before any commit/tree action (explicit paths only,
heads-up via herdr first). Blocked on Ben → `AWAITING-BEN.md` entry AND `needs-ben`, never idle
silently.
