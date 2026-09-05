# Handoff: fix #2149 — relay budget used up, needs re-slicing

Worktree: `/home/ben/Jarv1s/.claude/worktrees/fix-2149-recipe-status`, branch `fix/2149-recipe-status`.
I am `fix-2149-relay2` — already one relay past the original build agent, so per the one-relay
budget I am not spawning another successor in this session. This needs a fresh, separately-scoped
lane, not a third relay.

## Plan (approved by Ben) and the fix itself are both done and committed

Plan: `docs/superpowers/plans/2026-08-31-2149-recipe-status-approval-ordering.md` — read this
first, it has the full design with exact signatures.

Code commit: `ed962a3c4` on this branch — `fix(ai): make Approve wait for the tool write it
approved (#2149)`. Touches `packages/ai/src/gateway/confirmation-registry.ts` and
`packages/ai/src/gateway/gateway.ts`. `pnpm typecheck` passes clean on this commit (checked; the
first version of this change accidentally deleted a method still used directly by ~19 unit-test
call sites — fixed by keeping the old `resolve()` method alongside the new
`resolveAndAwaitCompletion()`, not replacing it).

**What's NOT done yet — this is the actual remaining work:**

1. The regression test from the plan's "Test plan" section: add `example.slowWrite` to
   `tests/integration/fixtures/example-tool-module.ts` (a copy of `example.write`'s handler with a
   real 20ms delay before it records the call), then add the test itself to
   `tests/integration/chat-mcp-transport.test.ts` (right next to the existing "write call blocks,
   emits action_request, approves, executes" test) that proves the fix: call
   `resolveActionRequest`, and immediately after it returns — no extra wait — assert the slow
   tool's write already happened. The plan spells out exactly why this must fail on the old code
   and pass on the new code.
2. A second small test also from the plan: resolving a rejected/cancelled action with no live
   waiter still returns promptly, doesn't hang.
3. Run the `verify-gate` skill for a scoped verification (never raw `pnpm verify:foundation`).
4. Run the existing UAT as the live regression proof:
   `tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts` — this is the test that
   originally caught #2149 (recipeStatus reading "missing" right after Approve).
5. `coordinated-wrap-up`: push, open the PR, post the live-path proof, report to the coordinator.

## Why this is a clean stopping point, not a mid-thought cut

The fix is complete and typechecks. What's left is writing and running tests against an
already-decided design — no more open questions, no more decisions to make. A fresh session can
start straight into TDD from the plan's Test plan section without re-deriving anything.

## Reminders (still apply)

- Coordinator: Herdr agent named `coordinator` — reconfirm exactly one live instance with
  `herdr agent list` before messaging it.
- Plain English in every message to the coordinator or any spawned agent — name what things do,
  not what the repo calls them (global CLAUDE.md rule).
- Open one PR closing #2149. Don't touch `docs/coordination`, don't run repo-wide formatting.
- Live-path gate applies: the PR needs the UAT run's proof pasted in, not just green tests.
