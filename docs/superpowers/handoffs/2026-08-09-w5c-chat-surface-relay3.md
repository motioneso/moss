# w5c-chat-surface relay 3 → 4 — 2026-08-09

**Issue:** #1254, lane C. **Branch/worktree:** `w5c-chat-surface`, clean, **still zero commits**.

## State: plan APPROVED by coordinator. Build not started. Start here.

Plan: `docs/superpowers/plans/2026-08-09-1254-approval-card-action-label.md` — read it in full,
it's self-contained (seams, exact field/signature diffs, 5 test cases, verification commands).
Coordinator (re-resolve pane fresh by label `Coordinator`, was `coord-waves36-r4` this write —
don't reuse the name, re-resolve) approved verbatim: "scope-correct, seams checked incl. the
out-of-glob tool-manifests.ts touch, no open forks. Proceed with the TDD build." No re-approval
needed — proceed straight to build.

**One fix already applied to the plan this relay, don't redo:** its Verification section originally
used `pnpm --filter @moss/ai exec vitest run ...`; rewritten to root `pnpm vitest run
tests/unit/<file>.test.ts` form per the new `pnpm-filter-test-is-a-false-green` memory (workspace
`--filter ... test` can exit 0 having run zero tests — 0-byte log is the tell). Always check the
log is non-empty with a `Tests N passed` line, not just `EXIT=0`.

## Next concrete steps (TDD, per the plan)

1. Write the 3 new cases in `tests/unit/gateway-summary-action-label.test.ts` (new file, copy the
   `buildGateway` harness from `tests/unit/gateway-action-preview.test.ts`), watch them fail red
   against current code.
2. Add case 4 to `tests/unit/external-tool-manifests.test.ts` (actionLabel passthrough), red.
3. Add case 5 to `tests/integration/external-module-gateway.test.ts` (DB-touching wire-proof) —
   run via `verify-gate` skill, not bare. Red.
4. Make the 4 contract changes named in the plan (`module-sdk/src/index.ts`,
   `external-module.ts`, `tool-manifests.ts`, `gateway.ts` `summaryFor()`), green all 5 new cases
   plus the unchanged `action-request-card-preview.test.tsx` regression check.
5. Full gate (`verify-gate` skill, isolated DB) before wrap-up.
6. `coordinated-wrap-up` skill once green.

## Relay trigger

Context-meter 70% warning, same as every lane. If it fires again before step 6, write relay 4 from
this doc's "Next concrete steps" position — do not re-derive the plan, it's already approved and
complete.
