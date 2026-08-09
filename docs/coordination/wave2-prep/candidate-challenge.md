# Wave 2 candidate challenge — 2026-08-08

Read-only challenge of #1155, #1207, #1115, #1433, and #1453 against the 78-item non-feature
backlog in #1470 and the freshness audits under `/tmp`. No production files were changed.

## Verdict

All five proposed issues are still actionable on `main` and have a small, identifiable root-cause
fix. None collides with an active Wave 1 production/test path (#1448, #887, #1412, #903, #1272),
and none requires a new product decision if its issue body remains the scope. Keep all five as the
next Wave 2 set, but place #1453 last because its deterministic-test rewrite has materially higher
verification risk than the other four.

If Wave 2 is required to be uniformly low-risk, reserve #1222 as the substitution for #1453. It is
a real production symptom with a narrow scanner/UI regression, but the audit shows the current
scanner already puts dot-directories in `rejected`; the settings rows still render rejected IDs,
so the acceptance must cover the rendered result rather than blindly copy the issue's original
scanner-only wording.

## Candidate matrix

| Issue | Tier / confidence | Root cause and smallest lane | Collision / dependency | Challenge |
| --- | --- | --- | --- | --- |
| #1155 | routine, high | `packages/module-registry/src/index.ts:904-925` still uses `${actorUserId}:${source}` as a pg-boss schedule key. Change only the key separator and add a real charset/assertKey regression (the fake boss does not exercise pg-boss v12). | No Wave 1 or candidate file overlap. Sibling #1147 is the precedent, not a blocking dependency. | Keep. This is a concrete runtime failure with a one-file production fix and focused test. Do not generalize key formatting. |
| #1207 | routine, high | `apps/web/src/chat/assistant-surface/surface.tsx` puts no live region on the transcript; only `TypingRow` announces. Add transcript-level `aria-live="polite"` and one focused render/a11y assertion. | No Wave 1 or candidate file overlap. Parent context #1193/#1196 and shipped PR #1204 are historical context only. | Keep. Small accessibility correctness fix; no sighted-UI redesign or product fork. |
| #1115 | routine, medium-high | `apps/web/src/tasks/task-list-view.tsx:228-246` renders both icon/text “Overdue” and the `jds-drift` “Overdue” pill. The issue already chooses the pill as the stronger signal; remove the duplicate indicator and update the focused UI assertion. | No Wave 1 or candidate file overlap. Sibling #1116 is a broader card-in-card design decision; do not bundle it. | Keep, with design-system review at build time. It is low-impact cosmetic work, but its acceptance is explicit enough to avoid a human decision. |
| #1433 | routine with log-safety review, high | `packages/datasets/src/client.ts` catches all fetch errors but logs only `HostPinningViolationError`; current `DatasetLogger` seam and Sports/News logger injection are already on `main` from #832. Log sanitized metadata for ordinary failures, preserve fallback/stale behavior, and add a non-pinning failure assertion in `tests/unit/dataset-client.test.ts`. | No Wave 1 or candidate file overlap; no longer needs the old composition-root wiring step because that wiring is present. Related #1431 is the prior host-fetch outage fix, not a blocker. | Keep. Highest useful impact in the set (an outage currently looks like a quiet day). Treat error fields as a security-sensitive review point: no message, body, credentials, or URL. |
| #1453 | routine, lower confidence / high verification risk | `tests/integration/connectors-google-schedule-root.test.ts:127-140` proves a negative property with a fixed 1.2s sleep. Replace wall-clock waiting with deterministic singleton/dedup evidence; retain a regression that fails when `singletonKey` is removed, and run the file repeatedly. | No Wave 1 or candidate file overlap. References merged #1450; do not absorb sibling #1454's workflow alarm. Requires DB-backed integration setup and careful scheduler semantics. | Keep last or substitute if the fleet needs only small routine lanes. This is not a production behavior change, but a bad rewrite can make CI less trustworthy. |

## Wave 1 collision check

The active Wave 1 branches currently touch only:

- #1412: `packages/ui/src/masthead.tsx` and its focused/UAT tests;
- #1448: `vitest.config.ts` and two News tests;
- #887: `tests/integration/notifications-hardening.test.ts`;
- #903: `packages/sports/src/followed-groups.ts`, `packages/sports/src/repository.ts`, and its unit test;
- #1272: `tests/unit/structured-state-manifest.test.ts`.

The proposed lanes touch `packages/module-registry/src/index.ts`, the assistant-surface files,
the Tasks view, the datasets client/test, and the Google schedule integration test. The sets are
disjoint. The shared-checkout docs and `.claude/launch.json` are pre-existing local changes and
are outside this challenge.

## Suggested merge/build order

Run all five from the same green `main` in parallel if the coordinator wants maximum throughput;
each builder must rebase and rerun its focused evidence after every upstream merge. For lower
verification risk, use this order for QA/merge:

1. #1207 (a11y attribute + focused test)
2. #1155 (pg-boss key charset fix + regression)
3. #1115 (single duplicate UI marker; design-system check)
4. #1433 (ordinary dataset error logging; sanitized-field review)
5. #1453 (deterministic integration-test rewrite, repeated-run proof)

No lane needs a migration, new dependency, OAuth/connector implementation, or live product
decision. #1207 and #1115 are user-facing and therefore need live-path evidence under the normal
gate; #1155, #1433, and #1453 need focused automated evidence, with #1453 additionally requiring
the repeated integration run and mutation/negative-control proof.

## Exclusions and approval forks

- Do not promote feature/product rows or decision-gate rows from #1470 merely because they are
  nearby in the audit. They require a spec or Ben's choice (for example #1249, #1252, #1266, or
  broad People/Lists work).
- Do not expand #1115 into #1116's visual redesign. The duplicate-marker choice is already in
  #1115; a broader Tasks visual pass would need a separate design decision.
- Do not expand #1433 into counters, alerting, or a new health protocol. The smallest useful fix is
  one sanitized warning per caught failure plus a regression; sustained-outage metrics can be a
  later lane if logs prove insufficient.
- Do not fix #1453 by removing the singleton or by weakening the schedule. The test must exercise
  the existing dedup contract and remain red when that contract is intentionally removed.
- Reserve #1222 only as the #1453 replacement after confirming the desired UI behavior for
  `rejected` module rows; otherwise it is a follow-up module-distribution lane, not a blind swap.

