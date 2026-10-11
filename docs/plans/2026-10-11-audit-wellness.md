# Wellness audit recovery and coverage plan

Status: approved bounded repair under [task #3397](https://github.com/motioneso/moss/issues/3397) and the committed umbrella plan `f0a11eec9`.

## Source and baseline

- Approved audit findings LIFE-01 through LIFE-05, 10 October 2026.
- Isolated implementation branch `ux/audit-wellness-20261011` is stacked on the existing visual owner's PR #3348 at `f3e6c057b621e76b79eab5e86b4c147edd30bb5e`.
- Exact baseline tree: `59bc999ef0a63eabb7f5a6793f27714d6d8c850a`.
- Preserve the active visual work, including the newer Wellness print renderer, shared dialogs, existing failed-export button recovery, and the merged #3337 Today medication clock.

## User outcomes and bounded changes

1. LIFE-01: older saved check-ins remain reachable and editable. Add stable, owner-scoped keyset pagination to the existing read endpoint; preserve the existing recent-check-in repository API. Page history explicitly and drain every page for a selected calendar window before deriving hero or chart data. Never substitute a larger arbitrary record cap or derive statistics from a partial page failure. Keep timestamp ties and removed cursor records traversable.
2. LIFE-02: dose rejection is visible, with the intended correction and optional as-needed reason retained. Scheduled-slot retries reuse the same slot/status because the existing repository upserts that slot. As-needed writes remain repeatable inserts; ambiguous transport failures must first offer a saved-dose recheck rather than blindly repeat an insert. Keep current optional-reason and no-extra-confirmation rules.
3. LIFE-03: show Pending, Taken and Skipped distinctly. State the consequence of the existing taken-to-skipped correction in accessible control text. Do not introduce an unlog API or alter medication scheduling.
4. Completed-day summaries: keep the approved fourteen completed local-day arithmetic and streak ending yesterday. Label both periods explicitly, acknowledge today's saved reflection, and retain unknown/loading/error states.
5. LIFE-04: disclose that export selection uses UTC calendar-day boundaries. The local-day export contract was explicitly deferred under #771; this lane does not alter the selected-day API contract.
6. LIFE-05: expose the existing 366-inclusive-day limit and parameter-conflict guidance, retain selected dates/categories and job identity across Close and route re-entry, and offer clear expired/unavailable-job recovery. Keep sensitive-category acknowledgment and truthful worker status. Keep the newer print fix unchanged.

## Ownership

Lane-owned implementation: Wellness page/history/trends/today/export UI, a focused module-local read/pagination helper, Wellness repository read path, and unique regression/live-proof tests. Existing check-in capture/edit, therapy notes, insight derivation, schedule calculations and print renderer stay unchanged.

Coordinator-owned deltas: shared Wellness DTO/schema, shared API client/query keys, app-map metadata, package scripts/lock and UAT trigger map. Send exact changes rather than edit those files concurrently.

Separate active work: #3260 Wellness AI-consent race and #3236 stopped-medication insight population remain deferred and outside this lane. #3372 manages preview-clock formatting separately. Do not touch Finance, Food, Job Search or Workshop.

## Verification and evidence

- Add focused tests before fixes and record the failing baseline: more than 50 history rows, timestamp ties/deleted anchors, more than 500 observations in a selected window, page-read failure atomicity, completed-day versus today labels, scheduled rejection/retry, ambiguous PRN failure without duplicate retry, export range/conflict/expiry/status failures, Close/reopen and route re-entry.
- Use only fictional synthetic records. No clinical claims and no real health-data sharing.
- Run scoped eslint/prettier, root and test TypeScript, UI/design-token/file-size checks, and relevant existing Wellness tests against the final code.
- Run database checks only through `scripts/run-gate.sh` under the verify-gate skill. Report an unavailable Docker gate explicitly; never redirect to a shared/live database.
- Author `tests/uat/specs/audit-wellness.uat.spec.ts` for the assembled UI/API/worker journey using real synthetic data, without network interception. Live proof must remain unverified until the approved real-backend gate can run.
- Prepare small local commits and a draft PR description. No push, publication, merge, deployment or force operation until the parent authorizes the next step.

## Completion boundary

Report code-complete versus verified stages separately. A focused unit pass is not assembled live acceptance, CI-green or merge readiness. Keep the visual owner's acceptance artifacts unchanged.

## Baseline regressions

At base `f3e6c057b`, `vitest run tests/unit/audit-wellness-recovery.test.tsx` returned exit 1: all nine new cases failed on the intended state, recovery, range/disclosure, conflict, re-entry and expiry assertions. No product edits preceded this run. The database baseline launch, `scripts/run-gate.sh start --gate test:wellness`, returned exit 4 with `docker not found — cannot launch the gate database server`; database and assembled live proof are not run. Dependencies were installed offline with pinned pnpm 10.6.2 and native lifecycle scripts disabled.
