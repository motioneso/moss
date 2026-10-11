# Opt-in News feedback fixture verification

Task: [#3397](https://github.com/motioneso/moss/issues/3397), bounded LIFE-06 through LIFE-10
repair coverage. Test infrastructure only; no production configuration or AI binding change.

## Scope and proof boundary

`audit-feeds.uat.spec.ts` opts into `withNewsFeedbackFixture: true` alongside the existing ESPN
fixture. Other specs leave the flag absent and retain their normal seeding behavior.
The local fixture serves declared synthetic RSS and model-ranking inputs only. Unknown paths,
including Moss overview and feedback API paths, return 404. No browser interception is used.

The opt-in seed calls the production News compiler through HTTP stand-in fetch/model ports and
uses the actual owner-scoped runtime repository and generation/CAS publication path. It checks
snapshot validity and nonempty stories, and fails if ranking fell back or no declared model
response was consumed. The real overview subsequently registers feedback targets. The UAT
requires a declared synthetic ranked story and its feedback reference in that real API response
before exercising feedback save, dismissal, edit, and removal through the UI.

This coverage does **not** prove production AI gateway/routing, live source discovery, or the
production refresh job. No external provider credentials are required or configured.

## Checks observed on the fixture candidate

- Passed: installed Vitest entrypoint, focused fixture protocol/runtime, provisioner, and runner
  suites: **41 tests in 3 files**. Runtime tests open the real local HTTP fixture and run the
  production compiler with explicitly **mocked persistence**; they do not connect to a database.
  Cases include candidate IDs and snapshot payloads, generation/CAS rejection, failed and
  malformed ranking responses, non-Moss API paths, isolated container command construction,
  idempotent cleanup, and opt-in forwarding/default absence.
- Passed: unmocked seed-module import under `node --import tsx`; no seed invocation or database
  connection was performed.
- Passed: scoped ESLint with zero warnings and Prettier checks for all fixture/plumbing/UAT files.
- Passed: repository file-size guard; no checked file exceeds 1,000 lines.
- Passed: Playwright **collection only**, two audit-feeds tests. No browser assertions executed.
- Blocked: the supported `scripts/run-gate.sh start --gate test:uat-seed` launcher exited **4**:
  Docker was not found, so its isolated PostgreSQL server could not launch. No direct DB command
  or gate bypass was attempted.
- Pending coordinator verification: root, tests, and web TypeScript checks on the final assembled
  tree; aggregate static checks; isolated DB/compiler-seed and actual browser UAT.

The feature remains code-complete, live-unverified until the isolated DB and browser path is
observed passing. Test collection and mocked-persistence runtime checks are not live-path proof.
Publication and acceptance decisions remain with the coordinator.
