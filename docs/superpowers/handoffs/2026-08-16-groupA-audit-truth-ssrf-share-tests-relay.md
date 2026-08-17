# Relay — groupA-audit-truth-ssrf-share-tests, 1st handoff

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-groupA-audit-truth-ssrf-share-tests.md`
**Handoff:** `docs/coordination/handoff-groupA-audit-truth-ssrf-share-tests.md` — **only exists
uncommitted in the main tree** (`~/Jarv1s`), not in this worktree or on the branch. Read it there.
**Issues:** #1252, #946, #1490 (all three, one PR, per handoff doc)
**Branch/worktree:** `groupA-audit-truth-ssrf-share-tests`, this worktree. No commits yet.
**Coordinator label:** `Coordinator` (herdr, re-resolve pane fresh) — session id
`11cf8264-55a8-4fa4-b32b-c8d086469f74`, notified of this relay already.

## State: spec premises verified against branch, plan NOT yet written

Did step ½ (verify spec vs. branch) for all three items. **Do not re-verify — proceed straight to
`plan-build`.**

### #1252 — audit outcome truth (`packages/ai/src/gateway/gateway.ts`)
Confirmed live at 3 sites (spec's line numbers drifted, pattern is real):
`outcome: result.ok ? "success" : "failed"` at lines **232, 272, 691**. Each followed by
`errorClass: result.ok ? null : "handler_error"`. `found.tool.isExternal` field exists —
first-party manifest tools get `isExternal: false` explicitly
(`packages/module-registry/src/index.ts:2066`); external module tools leave it unset, so
`isExternal !== false` (used already at gateway.ts:187,428) is the existing "is this external"
test — reuse it.
**Open design decision (yours to pin in the plan, spec deliberately left it open):** exact closed
set of conventional error shapes to detect + the new `error_class` value (spec suggests
`module_reported`, e.g. `{status:"error"}` / `{ok:false}` / `{error:<string>}`). Pin exact shape
matching logic and name in the plan as a decision, not code.

### #946 — SSRF BlockList hardening (`packages/host-fetch/src/index.ts`, NOT `policy.ts`)
**Spec text says `policy.ts` — that's stale/wrong.** `policy.ts` only has
`isPinnableHost`/`assertValidFetchHosts` (16 lines, no BlockList). The real `BLOCKED = new
BlockList()` + subnet lists are in `index.ts:123-154`; `isBlocked()` at `index.ts:376-380` already
regex-extracts dotted-form v4-mapped IPv6 (`::ffff:1.2.3.4`) and checks it against the ipv4 list —
confirmed by memory `PR #945 ... ::ffff:0:0/96 BlockList gap analysis`. Hex-form v4-mapped
(`::ffff:a9fe:a9fe`) slips through today because there's no `::ffff:0:0/96` entry in the ipv6 list
(index.ts:142-154) — add it there. Existing unit test file to extend:
`tests/unit/host-pinned-fetch.test.ts`. Six tests are spec-verbatim (issue #946 body) — read the
issue for exact list, not restated here to save context.

### #1490 — manage-share cross-owner write regression (`packages/tasks/src/repository.ts`)
`create()` (lines 198-320) already owner-scopes its idempotency probe
(`.where(sql<boolean>\`owner_user_id = app.current_actor_user_id()\`)` at line 216, fixed by
#1055/PR #1483, commit `7fc432f39`). Two UPDATE branches read from that owner-scoped `existing`
row: archived→suggested resurface (lines 219-241) and suggested-metadata resurface (242-252) —
both structurally safe since `existing.id` can only be the actor's own row. Worker-role call
sites confirmed live: `packages/connectors/src/monitor-jobs.ts:255-266` (`deps.taskPort.create`)
and `packages/module-registry/src/index.ts` `buildCalendarFollowThroughPort` (~724-750,
`tasksRepository.create`). No existing tasks test file covers this cross-owner regression
specifically — closest precedent/pattern: `git show 7fc432f39` (the #1055 test commit
`d3c151928`) for RLS-role-switching test harness conventions. Candidate new test file:
`tests/integration/tasks-cross-owner-share.test.ts` (repo convention: `tasks-*.test.ts` split,
per #1055's own split commit) — confirm no closer-fitting existing file before creating new.

## Next step for successor

1. Skip install (`node_modules` present).
2. `plan-build` → `docs/superpowers/plans/2026-08-16-groupA-audit-truth-ssrf-share-tests.md`.
   Three phases (one per issue), independent, kill-gate after phase 1 (#1252, the highest-risk
   design decision — the error-shape set). Pin #1252's error-shape set + error_class name as a
   plan decision.
3. Message Coordinator (`herdr agent prompt`, re-resolve pane by label first) with plan path,
   **STOP and wait for approval** before writing code.
4. TDD build, `coordinated-wrap-up`.

## Notes

- Relayed purely on the 70% context-meter warning during grounding — no code written, this is
  expected per the trigger (not a failure; premise verification is real progress, just not
  committable progress).
- Read spec/handoff BY SECTION only — full-reads are what bloated this session.
