# Lane 2007 state (relay 1 finished the build)

All seven tasks in `docs/superpowers/plans/2026-08-27-2007-credentialed-publisher-runtime.md`
are built, committed and pushed. **Pull request 2040 is open**, rebased on main, and recorded
in the fleet record as pr-open.

Nothing is left to build. What remains is CI going green and review.

## What was verified by running, not assumed

All unpiped, exit code preserved, all EXIT=0:

- eslint over the datasets, news and module-sdk packages plus the four test files
- prettier --check over the touched TypeScript
- pnpm typecheck
- pnpm check:file-size, pnpm check:package-deps
- the four new test files: 112 tests
- the regression list (dataset client, dataset cache, news feed source, news manifest,
  news service): 78 tests

## Deliberate gaps, already written into the PR

- No live proof. Nothing in this slice is reachable from the interface: no route, no manifest
  entry, no wiring. #2006 and #2008 own the first live proof.
- `readCredentialForUse` on the credential repository has no unit test. It is database code
  under row security and this lane may not run a database test. Integration gap for #2006.
- #2005's publisher-connection port was deliberately not implemented; its descriptor demands a
  retrieval method of feed or scrape and an API connection is neither. Raised on the PR as a
  question for #2008.
- This connection never carries article artwork. Also #2006.

## Rules that still bind

Plain English in everything a human reads, and pass that on to anything you spawn. Never run a
database-touching test outside the `verify-gate` skill. Never pipe a gate. `git add` by explicit
path only. Report through `node /home/ben/jarv1s-fleet/fleetctl.mjs`.
