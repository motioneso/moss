# Continuation: #1554 persistent-provider-chat-runtime (relay #5)

Branch/worktree: 1554-persistent-provider-chat-runtime (this worktree). Clean tree, nothing
committed. Relay #4 (same dir) covered the approval-request send; this doc supersedes its
"WAITING" state — the Fable cycle it was waiting through is now done.

## State: plan is FINISHED, Fable-APPROVED, build not yet started

`docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md` is **authoritative and
build-ready**. Read it in full (427 lines) — do not re-derive. It went through two Fable review
rounds this session, both recorded in its own "Rulings ledger" section (bottom of file):
- Round 1: REVISE. Core design (Decision 2's `sessionReaped` RpcPush channel) approved. Two
  binding findings fixed in-doc: token-revocation e2e now uses in-process spy tests only (no new
  introspection route — see the doc's "Finding A" section); `routes.ts` edit scope + a concrete
  lane-#1256 conflict protocol added (see the doc's "Finding B" section, binding, read before
  touching `routes.ts`). Nit applied: `RpcPush` is a discriminated union now.
- Round 2: **APPROVE**, with one mechanical fix already applied — e2e-P2 lives at
  `tests/integration/persistent-pool-reap.test.ts` (run via a new `test:persistent-pool` root
  package.json script, `tsx scripts/test-integration.ts ...`), not a nonexistent
  `packages/chat` test runner.

**No further Fable pass needed — proceed straight to build.**

## Coordinator status

Sent an update (msg_id `846cc229-4a2f-4fe1-8bda-f606b189a89c`) to
`coord-overnight-20260810-e7 [19fedb]` summarizing both Fable rounds and stating build will
proceed under the standing Phase 2 approval unless they object. **No reply yet as of this
checkpoint.** First action in the next session: check for a reply (re-resolve the coordinator
fresh via `ListAgents`/`herdr pane list` if that name no longer resolves — do not trust it
blindly). If no objection, proceed to build. Do not re-ping again beyond this.

## Next steps (in order) — this is the actual build, not yet started

1. TDD-build Phase 2 task-by-task per the plan's Decisions 1-4 (in the doc, each has exact
   signatures/DDL and test cases — no function bodies to invent, just implement against the
   stated contracts). Suggested order: Decision 1 (`PersistentRuntimePool` class, new file
   `packages/chat/src/live/persistent-runtime-pool.ts`) → Decision 4 (settings registry entries,
   independent) → Decision 2 (`RpcPush` union extension, `handleRemoteReap`, client push
   handling) → Decision 3 (timer wiring in the two composition roots) → wire into the single fork
   point (`engine-selection.ts:76-92`) → `engine-host.ts` (lift the `persistentRuntimeEnabled:
   false` pin at line ~252) → `runtime.ts` composition root.
2. **Before touching `packages/chat/src/routes.ts`: read the plan's "Finding B" section in full
   and follow its 5-step conflict protocol** (lane #1256 touches the exact same textual region —
   confirmed via direct diff against the sibling worktree this session). Do not skip the
   merge-state check.
3. Commit per task: explicit scoped `git add <path>` only, never `-A`/`.`. Any commit touching
   `routes.ts` goes through the `shared-checkout` skill first (co-edited file, CLAUDE.md mandate).
4. Write/run the e2e-P2 integration test (`tests/integration/persistent-pool-reap.test.ts` +
   `test:persistent-pool` script) and each Decision's own test cases — all stated in the plan,
   just implement them.
5. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
6. `coordinated-wrap-up`: `verify-gate` skill for the full gate (needs DB isolation — see that
   skill), push, open PR. Live-path proof: this phase has **no UI surface** (plan's "Determinism
   boundary" + "Finding A" sections both state this explicitly) — the honest report is
   code-complete-and-integration-tested, not a live-UI Playwright proof; say so plainly in the PR,
   don't claim a UI live-path check that doesn't apply. Report PR + evidence to
   `coord-overnight-20260810-e7` (re-resolve fresh if stale). Never merge/close issues/touch
   board.
7. Relay again on the next 70% context-meter warning or compaction summary.

## Collision note + bans (still binding, unchanged)

Lane #1256 collision — see plan doc's "Finding B" section for the full protocol, don't re-derive.
Worktree/branch-scoped git only. Explicit-path `git add` only. Never touch `docs/coordination/`,
the project board, milestones, or merge. No secrets anywhere.
