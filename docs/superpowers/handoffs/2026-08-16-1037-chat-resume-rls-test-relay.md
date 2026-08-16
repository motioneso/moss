# Relay — #1037 chat-resume RLS test

**Spec (per handoff, row #1037):** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`
(only exists in the main tree at `/home/ben/Jarv1s`, local commit `bcf90b253`, not yet on
`origin/main` — read it from there, not this worktree).
**Issue:** #1037. **Risk tier:** security. **Branch:** `1037-chat-resume-rls-test` (this worktree).
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows exactly one pane with this
label before messaging; resolve fresh, never reuse a `…-N` from this doc.

## Status: plan APPROVED — proceed straight to build

The plan is committed at `docs/superpowers/plans/2026-08-16-1037-chat-resume-rls-test.md` (this
commit). It traces the full ownership-enforcement chain file:line
(`packages/chat/src/live-routes.ts:335-366` → `chat-session-manager.ts:671-700` →
`persistence.ts:334-344` → `repository.ts:283-302`) and confirms RLS is the sole ownership guard
(no app-level `owner_user_id` filter). Read the plan file for full seams/task/verification detail
— it is complete and self-contained; do not re-derive it.

The coordinator (`coordinator-take25`, session `11cf8264-55a8-4fa4-b32b-c8d086469f74`) approved
explicitly: "plan matches the #1037 spec row exactly (tests-only, resume-path denial + owner
positive control, no production change). Proceed to build." No fork flagged. **Do not re-request
approval — go straight to step 1 below.**

The spec-status discrepancy (spec doc header said "draft" vs handoff's "approved") is resolved:
coordinator confirmed Ben approved the whole 4-item batch in chat on 2026-08-16; the doc's status
header just hadn't been updated yet. Not a blocker, no further action needed.

## Next steps (approved — build now)

1. Build `tests/integration/chat-resume-privacy.test.ts` via `superpowers:test-driven-development`,
   per the plan's Test 1 (actor B denied resuming actor A's thread — 404, no row disruption) and
   Test 2 (owner positive control — 204). Mirror `tests/integration/chat-live-api.test.ts`'s
   `beforeAll`/`afterAll` scaffold and its owner/other-actor pattern at lines ~312-339.
2. Commit with `Co-Authored-By: Claude`, staging only the new test file by explicit path.
3. Verify: `pnpm test:integration tests/integration/chat-resume-privacy.test.ts > /tmp/1037-test.log 2>&1; echo "EXIT=$?"`
   — expect 0, both tests passing.
4. **Kill gate:** if Test 1 fails on the first honest run (B's resume returns 204 or thread
   content), that's a real RLS gap — STOP, do not patch production code, escalate `[SECURITY]` to
   the coordinator. Do not silently fix.
5. Pre-push trio + rebase: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
6. Full gate on an isolated gate DB — use the `verify-gate` skill's recipe, never run
   `pnpm verify:foundation` unscoped.
7. `coordinated-wrap-up`: push, open PR stating explicitly this is an internal-only test change (no
   live-path proof needed, per handoff), report PR + evidence to the coordinator. Do not merge,
   touch the board, or close the issue.

## Known non-blocking flag

The spec file's own header says "draft, pending Ben's approval" while the handoff calls it
approved. I proceeded on the handoff's authority (its #1037 content is unambiguous either way) and
flagged this to the coordinator in the same approval-request message. No action needed unless the
coordinator raises it back.

## Collision notes (unchanged from handoff)

- #1038 (separate worktree `1038-chat-privacy-leak-test`) covers list/detail history endpoints —
  zero file overlap by design; test filename `chat-resume-privacy.test.ts` is distinct.
- Never modify `tests/integration/test-database.ts` (shared fixture, read-only reuse of
  `ids.userA`/`ids.userB`/`ids.sessionA`/`ids.sessionB`).
- Never touch `docs/coordination/`, the board, or merge.
