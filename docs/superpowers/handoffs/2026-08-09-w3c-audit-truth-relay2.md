# #1136 lane C relay handoff (relay 2 → relay 3)

Branch: `w3c-audit-truth`. Worktree: `~/Jarv1s/.claude/worktrees/w3c-audit-truth`.
Plan: `docs/superpowers/plans/2026-08-09-1136-codex-persona-marker-fencing.md` (approved,
revised once already — read it in full before touching Task 2, don't re-plan).

## Done, verified, committed

- **Task 1 (prompt-safety.ts) — DONE.** Commit `c5a8943bc`. Fable's REQUEST-CHANGES applied:
  two-pass regex in `packages/chat/src/live/prompt-safety.ts` — `ROLE_MARKER_COLON_RE` (colon
  required, decoration optional) + `ROLE_MARKER_HEADER_RE` (colon-less, decoration required).
  19/19 tests green in `tests/unit/chat-recall-seed.test.ts`. Plan-doc revision was precursor
  commit `b218a00`.
- Coordinator (pane `w1:p3R`, session `9c7ffdf7...`) already told "applied+committed" — do not
  repeat that message, they've closed their check on it.
- Task list: TaskList items #1 and #2 marked `completed` in this session's tracker (tracker is
  per-session — recreate/reclaim in the new session if it doesn't carry over).

## Not started — your job

**Task 2: `packages/chat/src/live/codex-exec-session.ts` fencing.** Full spec is in the plan doc's
Task 2 section — read it fresh, it has the exact `UNTRUSTED_REPLAY_NOTICE` text and 5 test cases.
Summary: import `neutralizeSeedFraming`; neutralize `turn.user`/`turn.assistant` for every
`priorTurns` entry in `buildPrompt`; prefix `this.replayBatch` with the notice when defined;
neutralize current-turn `text` before the trailing `User: ${text}` line; `personaText` stays
untouched (non-goal). New test file: `tests/unit/chat-codex-exec-session.test.ts`, mirror the
`makeIo()` stub-`TmuxIo` pattern in `tests/unit/cli-chat-engine-probe-security.test.ts:1-11`.

TDD: RED first (unpiped: `pnpm vitest run tests/unit/chat-codex-exec-session.test.ts > <log> 2>&1;
echo "EXIT=$?"`), watch it fail for the right reason, implement, GREEN, commit explicit-path
(`git commit packages/chat/src/live/codex-exec-session.ts tests/unit/chat-codex-exec-session.test.ts
-m "..." ` with `Co-Authored-By: Claude <noreply@anthropic.com>` — diff-check first per
shared-checkout skill, this is a shared tree).

## After Task 2 is green and committed

1. `pnpm --filter @moss/chat test -- chat-recall-seed chat-codex-exec-session > <log> 2>&1;
   echo "EXIT=$?"` — expect EXIT=0, all cases green.
2. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck > <log> 2>&1; echo "EXIT=$?"`.
3. Rebase onto latest, push, open PR.
4. Post required Opus adversarial QA verdict as a `gh pr comment` (security-tier lane, mandatory
   per spec). No live-path UI proof required — this is internal/security, not user-facing UI.
5. Report to Coordinator (re-resolve pane fresh via `herdr pane list` — don't reuse `w1:p3R`,
   it will have reflowed).
6. Run `coordinated-wrap-up` (gate on isolated DB per `verify-gate` skill — never pipe, never run
   unscoped).

## Traps already hit this lane (don't re-hit)

- Any verification/gate command run piped is blocked by the repo's `check-gate-pipe.sh` hook —
  always `cmd > logfile 2>&1; echo "EXIT=$?"`, read the log separately.
- This is a shared checkout — never `git add -A`/bare `git commit`; explicit paths only, diff
  every co-edited file before staging, `git show --name-only HEAD` after to confirm exactly the
  intended files landed.
- Herdr `pane_id`s reflow on every pane open/close — always re-resolve via `herdr pane list`
  immediately before messaging, never reuse an id from this doc or an earlier tool result.
- Relay trigger is the context-meter's 70% warning — don't invent a higher threshold, don't try
  to finish "just one more task" past it. Write the next handoff doc and spawn a successor.
