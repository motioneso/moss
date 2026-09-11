# Tasks Park Office, Slice 4: Live verification and release

**Goal:** Prove the finished Tasks experience through the real UI, and leave one release-ready PR with truthful evidence.

**Architecture / Tech Stack / Constraints:** Read the [shared plan](2026-09-09-tasks-park-office.md), [spec](../specs/2026-09-09-tasks-park-office-design.md), and current live-path/verification rules. This is verification, not another design expansion.

**Entry / dependency:** Slice 3 code-complete with database-free checks passing. Implementation issue/branch/PR and canonical theme readiness are recorded.

## Task 1: Add executable real-path coverage

**Files:** Create `tests/uat/specs/tasks-park-office.uat.spec.ts` using the existing UAT harness and its `uatLevel` convention; update the task handoff. Read `tests/uat/run-uat.ts`, `tests/uat/playwright.uat.config.ts`, and the current provisioning/auth helpers before running anything.

- [ ] Build a bounded UI scenario using a disposable provisioned actor/environment. Follow real signup/login and the actual Tasks navigation/module path; do not use admin access to another actor's private data.
- [ ] Through the actual page, capture a title-only task, open Details, exercise supported optional fields/tags/subtasks and save, then prove persistence after reload. Use deliberately identifiable test data, not personal production tasks.
- [ ] Select a list in the index, switch to Grid and back, and assert the same collection and relevant filters remain active. Resize to mobile and assert the compact control represents the same state; then reset All lists.
- [ ] Complete/reopen a test task and verify server-confirmed state; exercise suggested review if fixtures provide it. Assert the preference reloads to the selected List/Grid view.
- [ ] Assert the rendered masthead/index/section structure and usable element bounds using bounded DOM/computed-style evidence. Keep visual references separate: screenshots do not satisfy the live-path gate.

## Task 2: Run gates and record real evidence

**Files:** Existing task tests and app-map declarations; update the task handoff/evidence links. Modify implementation only for reproduced in-scope failures, rerunning the affected slice checks.

- [ ] Re-run task unit tests, mocked browser suite, token/contrast checks, and Tasks app-map assertions. Keep mocked browser results explicitly labeled as such.
- [ ] Run the static release gate (`pnpm verify:static`) and record the exit code and bounded failures. Address new failures; identify unrelated shared-checkout failures separately without claiming green.
- [ ] Run `pnpm verify:foundation` only through the repository's protected verification procedure against an isolated approved target. Never invoke it casually against live dev or pipe away failures.
- [ ] Run the scoped live test via the established harness (`pnpm test:uat tasks-park-office`) only after confirming isolation/provisioning safety. Record target/revision, exact command, exit code, assertion summary, and artifact path. If policy/tooling is unavailable, report the missing verification instead of bypassing it.
- [ ] Verify the candidate on the real live dev instance through the same reachable UI path; isolated UAT alone does not establish which revision is installed on shared dev. Record the deployed revision and bounded assertions. Use authorized test data and the normal deployment workflow, not an unrequested prod deployment.
- [ ] Record real-path evidence on the PR when implementation publishing is authorized: UAT run link, exit code, revision, and bounded DOM/network evidence. Never include credentials, cookies, session tokens, or raw private data.

## Task 3: Release-ready handoff

**Files:** Task plan checkboxes and handoff; PR metadata, not a manual edit to `docs/WHATS_NEW.md`.

- [ ] Review the final diff for spec compliance, token scoping, retained functionality, correct app-map ownership, and absence of unrelated edits. Use shared-checkout safeguards for any path-scoped commits.
- [ ] Complete the PR release note: Category **Changed**; Title **A refreshed Tasks page**; Description **Tasks now pairs a park-inspired layout with a visible list index, keeping quick capture and both task views close at hand.**
- [ ] Confirm required CI checks and reviews on the exact candidate revision, plus live-path evidence. Keep one PR for all slices and link the approved spec/task.
- [ ] Report precisely: **release-ready** when all gates pass, or **code-complete, unverified** with the missing evidence. No merge or production deployment is implied by this planning request.
- [ ] When normal merge authority is granted and the PR actually merges, update GitHub tracking and let the existing release-note workflow maintain release history. Do not mark Done earlier.

## Exit

The user can capture, organize, view, and act on real tasks through the approved design, all required gates have evidence, and the PR/handoff accurately states what is shipped versus merely ready.
