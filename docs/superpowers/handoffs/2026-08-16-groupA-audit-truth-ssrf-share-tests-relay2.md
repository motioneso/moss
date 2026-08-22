# Relay — groupA-audit-truth-ssrf-share-tests, 2nd handoff

**Plan:** `docs/superpowers/plans/2026-08-16-groupA-audit-truth-ssrf-share-tests.md` (approved by
Coordinator, no fork). **Do not re-verify or re-plan — proceed straight to Phase 3 TDD build.**
**Branch/worktree:** `groupA-audit-truth-ssrf-share-tests`, this worktree.

## Done and committed (Phases 1 + 2 of 3)

- **Phase 1 (#1252, commit `cd5c909b6`):** `packages/ai/src/gateway/gateway.ts` — `runHandler`
  returns `{response, moduleReportedErrorClass}`, detected pre-sanitize on raw `ToolResult.data`,
  gated `isExternal !== false`, closed shape set (`status:"error"`/`ok:false`/`error:<string>`).
  All 3 `recordAudit` call sites updated. Kill gate did not trigger (exactly 3 callers, top-level
  scalar checks only). 46/46 unit tests green, root `tsc --noEmit` clean.
- **Phase 2 (#946, commit `a76c15b2a`):** `packages/host-fetch/src/index.ts` — closes the hex-form
  v4-mapped IPv6 SSRF gap. **Deviated from the plan's literal one-liner** (`addSubnet("::ffff:0:0",
  96, "ipv6")`) after discovering empirically that Node's `BlockList` treats that subnet as
  covering the ipv4 address space too — it would have blocked every legitimate outbound ipv4
  fetch. Fixed instead by extending `isBlocked()`'s existing dotted-form v4-mapped regex
  normalization to also handle hex-form. Full detail in agentmemory (bug, concepts
  `host-fetch,BlockList,SSRF,node-net-blocklist,v4-mapped-ipv6`) — search that before touching this
  file again. 20/20 unit tests green (6 new + 14 existing), root `tsc --noEmit` clean.
- Coordinator (`herdr agent prompt`, name `coordinator-take25` or re-resolve by label
  `Coordinator`) already notified of Phase 1 completion + the kill-gate pass. **Not yet notified of
  Phase 2 or the BlockList deviation** — successor should send that update, ideally combined with
  Phase 3's own completion to save a round-trip, unless Phase 3 runs long.

## Next: Phase 3 — #1490 manage-share cross-owner write regression (tests only)

Read the plan's Phase 3 section (`sed -n '/Phase 3/,/Cross-phase invariants/p'` on the plan file) —
not restated here to save context. Key facts already verified pre-plan (do not re-derive):

- Target file: `tests/integration/tasks.test.ts` (existing #1055 regression test at line 814,
  `git show d3c151928`). Confirmed no closer-fitting file exists.
- **Tests only, no production code change** — `packages/tasks/src/repository.ts`'s owner-scoped
  `existing` probe (line 216, fix `7fc432f39`) is believed already closed. If any new test finds it
  is NOT closed, **stop and report to Coordinator** rather than silently patching `repository.ts`
  mid-phase (per plan's explicit non-goal).
- 3 assertions: (1) manage-level share cannot cross-owner-UPDATE via the probe path — B's `create()`
  with a colliding `source`/`externalKey` against A's `manage`-shared task must produce a **new
  row**, not an update to A's; (2) A's row is byte-untouched after, check `updated_at` specifically;
  (3) worker-role coverage via a new `workerDataContext()` helper in `tasks-helpers.ts` (mirror
  `handleNextTaskJob`'s pattern, lines ~60-65) — positive case + fail-closed `{} as never` guard
  test mirroring `tasks.test.ts:728-731`.
- Exit criteria: scratch-revert the `repository.ts:216` owner-scoped filter, confirm assertions 1-2
  go red, then restore and confirm green on the real tree.

## Verification commands for Phase 3 (unpiped, per plan)

Use the `verify-gate` skill's scoped runner for `tests/integration/tasks.test.ts` — **never** a raw
`pnpm test` against the shared dev DB (hits live data). Root `tsc --noEmit` afterward, same as
Phases 1/2.

## Process reminders

- `shared-checkout` skill before every commit (explicit paths, diff-review each file first — this
  worktree is shared).
- Commit per task, not one giant Phase 3 commit, if it naturally splits (helper function vs. the 3
  test assertions).
- After Phase 3 is committed and verified: this is the last phase — move to PR creation /
  `coordinated-wrap-up`, not another relay, unless something unexpected comes up.
