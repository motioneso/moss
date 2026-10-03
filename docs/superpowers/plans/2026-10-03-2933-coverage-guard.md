# Plan: close the two coverage-guard gaps (#2933)

Routine, tests-only. One file changes: `tests/unit/model-call-coverage.test.ts`.
No user-facing change, so no UAT spec and no live proof.

## Verified premises (on this branch)

- `packages/cli-runner/src/per-user-structured.ts:95` defines
  `preparePerUserStructuredLaunch`, which hands back a runner as `io`.
  Its only caller, `packages/cli-runner/src/engine-host.ts`, is already in
  `RUNNER_CALL_ALLOWLIST`. No allow-list churn needed.
- Guard header claims seven runner names (`model-call-coverage.test.ts:52`);
  the pattern at `:408` lists seven. Re-export skip is at `:438`. The only
  real-tree runner re-export is a plain (unrenamed) one in
  `packages/cli-runner/src/index.ts:17`, which keeps its current behavior.

## Task 1: name the launch-prep helper

- Decision: add `preparePerUserStructuredLaunch` to the runner-name pattern;
  header "seven names" becomes eight. `engine-host.ts` entry is already listed.
- Test (behavior): an unlisted fixture file that calls the helper and runs a
  program through the returned `io` is flagged as a runner hit in an
  uncovered file. It fails against a broken guard because the fixture names
  only the new helper; with the name missing from the pattern there is no hit.
- Gap-reopen proof: remove the name from the pattern, watch the new test go
  red, restore it.

## Task 2: catch renamed re-exports

- Decision: collect aliases from `export { Orig as Alias } from "..."` lines
  where `Orig` is a known runner name, and flag uses of `Alias` in any file
  with the same comment-line skipping. The existing skip of the re-export line
  itself stays, so the plain barrel re-export in `index.ts` stays green and
  the "does not flag a re-export" test keeps passing.
- Header states the residual precisely: only `export ... from` renames are
  tracked; a locally-defined alias re-exported without a `from` clause and
  consumed elsewhere still escapes.
- Test (behavior): a fixture pair — one file re-exporting a runner under a new
  name plus an unlisted consumer using the new name — flags the consumer file.
  It fails against a broken guard because nothing else in the consumer names a
  known runner.
- Gap-reopen proof: disable alias collection, watch the new test go red,
  restore it.

## Verification (each unpiped, expected exit 0 unless noted)

- `pnpm vitest run tests/unit/model-call-coverage.test.ts > /tmp/guard-2933.log 2>&1; echo "EXIT=$?"`
- Gap-reopen runs of the same command, expected exit nonzero, before restore.
- Pre-push trio plus fresh rebase before pushing.

## Kill gate

If alias tracking flags any real-tree file outside the allow-list (a real
renamed runner re-export exists), stop and escalate to the coordinator rather
than widening scope. Owner of that call: the coordinator.
