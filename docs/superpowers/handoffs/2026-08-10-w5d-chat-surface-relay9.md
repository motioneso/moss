# w5d-chat-surface relay #9

Worktree: `~/Jarv1s/.claude/worktrees/w5d-chat-surface`, branch `w5d-chat-surface`, PR #1482
(#1255 + #1451). Re-resolve fresh via `herdr agent list` / `herdr pane list` — do not trust any
name/session baked into this doc. Coordinator confirmed legit: pane `w1:p42`, codex session
`019fe9e2-7fc6-7243-9894-d258562db9a6` (see agentmemory `project: jarv1s`, search "needs-ben
spoofed" for why that took verification).

## Live task: Fable's RED ruling on PR #1482 — fix the persona boot gate

Fable ruled the branch is RED (changes-required), not CI-flake: branch e2e has 31 timeouts + 17
failures vs main green, caused by a real regression, not fleet contention. Full diagnosis already
sent to Coordinator and saved to agentmemory (`project: jarv1s`, search "persona-gate-regression"
or read `mem_msmyocpf_fdafeaea110c`) — **read that memory before redoing any investigation.**

**Confirmed root cause:** commit `5ef6f3352` (#1451) added an unconditional
`if (personaQuery.isLoading) return <LoadingScreen />;` at `apps/web/src/app.tsx:212-213`,
blocking the whole app shell boot up to 4s (`getPersonaSettings`'s AbortController timeout,
`apps/web/src/api/client.ts:344-356`) on every fresh page load. `tests/e2e` has zero stubs for
`/api/me/persona` — every e2e spec now pays that ~4s delay it didn't before. Existing coverage
(`tests/unit/chat-drawer-availability.test.tsx`) only covers `chatAvailableFromRoute`, nothing
exercises this gate.

**Correction:** the earlier theory of "CI cancelled by unattributed fleet contention" (issue #1509,
memory `mem_msmvqu1d`) is superseded — Fable says it's a deterministic 35-min job timeout firing
because e2e is genuinely broken, not contention. Don't re-litigate that; #1509 can be closed
referencing this finding once the fix lands.

**Fable's explicit instructions, in order — diagnosis was sent, go-ahead not yet confirmed as of
this write:**

1. Add coverage that fails against the current unconditional gate (a unit/component test
   asserting the app shell renders — or at least doesn't hard-block — while `personaQuery` is
   pending).
2. Implement the **minimal** fix. Do NOT raise the CI timeout as the remedy. Leading candidate:
   stop full-app-gating on `personaQuery` entirely — persona only affects the drawer
   header/composer placeholder name cosmetically (see `apps/web/src/api/use-assistant-name.ts` and
   its consumers), so let those specific components handle their own pending/fallback state
   instead of blocking all boot. Confirm this doesn't reopen the original #1451 bug (name flashing
   default before custom loads) — check whether `useAssistantName`'s consumers already have a
   graceful loading state, or need one added.
3. Run focused/local checks (unit tests touching this + typecheck) — do NOT run
   `pnpm verify:foundation` raw, use the `verify-gate` skill if a full gate run is needed.
4. Push normally (single normal push — this supersedes an earlier "freeze, no push" instruction;
   Fable's new instruction explicitly says push so automatic CI starts on the new head).
5. Separately produce **#1451 live UI proof** (Live-Path Gate — installed and exercised through
   the real UI on a live dev instance, not just green CI). See `docs/DEVELOPMENT_STANDARDS.md` and
   memory `e2e-dev-uat-for-ui-features` for how that's normally done.
6. **No merge.**

**UPDATE: GO received from Coordinator/Fable.** Implementing now — see agentmemory `project:
jarvis`, type `bug`, search "app-persona-boot-gate" for the exact test-writing plan (TDD, TanStack
Query v5 `isLoading` semantics gotcha re: forcing pending state under this repo's no-jsdom
renderToString test convention). Do not bundle #1534. Do not manually rerun CI or change any
timeout. Local full-gate queue is occupied — Fable authorized focused local checks
(unit + typecheck/format/lint) plus automatic current-head CI in place of a full gate run.

## Protocol reminders

Shared checkout — use the `shared-checkout` skill before any commit (explicit paths only, never
`add -A`/bare commit). If blocked on a Ben decision, log to `AWAITING-BEN.md` AND
`needs-ben <name> "<question>"` — never idle silently. Note:
`docs/coordination/AWAITING-BEN.md` has diverged between the main tree (`/home/ben/Jarv1s`, has an
uncommitted edit resolving a separate needs-ben spoofing thread) and this worktree's tracked copy
(older, missing later main-branch entries) — don't blind-commit that file from here; see memory
`AWAITING-BEN-divergence`.
