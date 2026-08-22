# Verify foundation performance — parallel lanes without a weaker gate

**Date:** 2026-08-22

**Status:** Draft for Fable review

**Tracking:** TBD follow-up task to closed issue
[#1534](https://github.com/motioneso/moss/issues/1534). Create the task before implementation;
do not reopen #1534, whose timeout-only scope is complete.

**Grounded on:** `origin/main` = `be039398e640b52d80bf84ca9115763adbe90b51`, the eight most
recent successful `main` CI runs through run `32553230657`, PR run
[`32555181757`](https://github.com/motioneso/moss/actions/runs/32555181757), and
[`docs/research/2026-08-22-ci-foundation-performance.md`](../../research/2026-08-22-ci-foundation-performance.md).

## Outcome

Reduce the required code-path CI critical path from a recent median of 27m53s to **12 minutes or
less** without skipping tests, weakening database isolation, changing assertion timeouts, or
renaming the required `CI gate` check.

After change-scope detection, run three independent lanes:

1. foundation checks without the broad integration suite, with unit test files parallelized;
2. exactly two integration shards, each on its own GitHub runner and PostgreSQL cluster;
3. the existing mocked-API Playwright suite, which does not need PostgreSQL.

The existing Compose smoke jobs remain parallel and unchanged. `CI gate` continues to be the only
required check and fails closed unless every applicable lane succeeds. Image publication waits for
all lanes that used to be inside `Verify foundation and app`.

Two integration shards are the ceiling for this change. They should bring the integration path
near the shortened foundation/browser paths; a third shard would spend another runner without
shortening the critical path unless measurements disprove that balance.

## Current truth

### The run was healthy, not stuck

PR run `32555181757`, job `96988119981`, completed successfully in 29m56s. Its 24m55s foundation
step passed 627 unit files / 5,133 tests, 12 UAT-seed files / 29 tests, and 212 integration files /
2,043 tests. The time was concentrated in two serial Vitest phases:

| Foundation phase  | Wall time | Share |
| ----------------- | --------: | ----: |
| Integration tests |    17m03s |   68% |
| Unit tests        |     5m22s |   22% |
| UAT seed tests    |       12s |    1% |
| All other checks  |    ~2m18s |    9% |

After foundation, the same job reran release hardening for 28s, built the web app for 17s,
installed Chromium dependencies for 29s, and ran Playwright for 2m49s.

The eight latest green `main` samples are consistent with a slow serial pipeline rather than a
branch regression:

- verify-job median: **27m53s**, range 25m37s–30m24s;
- foundation-step median: **23m16s**, range 21m09s–25m13s;
- investigated PR foundation: **24m55s**, inside that green-main range.

This follows #1534 rather than replacing it. #1534 gave the monolithic job evidence-based phase
deadlines and a 45-minute backstop; it explicitly excluded sharding and job splits. Those timeout
semantics remain load-bearing while this spec changes the execution shape.

### Why unit tests are needlessly serial

`vitest.config.ts` sets `pool: "forks"` and `fileParallelism: false` globally. Integration needs
serial files because one Vitest invocation shares one isolated database and resets it between
suites. Unit files do not share that constraint, but inherit the same setting.

Vitest documents that disabling file parallelism forces `maxWorkers` to 1. Vitest 4.1.8 also merges
CLI options after configured options, so a unit-wrapper override can safely supersede the global
default without adding a second config file:

- [Vitest `fileParallelism`](https://vitest.dev/config/fileparallelism)
- [Vitest 4.1.8 config merge](https://github.com/vitest-dev/vitest/blob/v4.1.8/packages/vitest/src/node/plugins/index.ts#L222-L224)

A same-machine directional benchmark ran the identical 605-file `tests/unit` scope both ways.
Both runs had the same one checksum assertion failure on the dirty coordinator checkout and 5,034
passing tests, so the result is not acceptance evidence; the timing signal is still useful:

| Mode                          | Vitest duration |
| ----------------------------- | --------------: |
| Current serial file execution |         253.68s |
| Unit-only file parallelism    |          52.52s |

That is a 4.83x local speedup with no additional failing file.

There is one important wrapper trap: `scripts/test-unit.ts` and `scripts/test-integration.ts`
replace their default directory whenever any CLI argument is present. Passing only
`--fileParallelism` or `--shard=1/2` therefore drops `tests/unit` or `tests/integration` and lets
Vitest collect every configured suite. The unit override belongs inside the unit wrapper. Every
shard command must carry the explicit `tests/integration` filter.

### Why integration must shard across runners

`scripts/test-integration.ts` already creates and drops a unique database per invocation. Current
`origin/main` also derives throwaway module-role identities from the lane database (#1625).
However, each integration reset performs cluster-global role DDL behind `withClusterDdlLock`.
Concurrent shards on one PostgreSQL cluster would contend on that lock and would recreate the
cross-lane pressure fixed by #1013/#1632.

A GitHub matrix creates one job per shard. Each hosted job gets its own runner and Compose cluster,
so the existing integration wrapper is the isolation boundary and the cluster-global lock remains
local to one shard. Vitest's native `--shard=<index>/<count>` splits test files before sorting and
works in the existing non-watch `vitest run` mode:

- [Vitest sharding](https://vitest.dev/guide/improving-performance#sharding)
- [GitHub matrix jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)

Use the built-in sequencer. It balances file counts, not historical duration, so shard skew is a
measurement to report, not a reason to build a custom sequencer in advance.

### Why Playwright is independent

`playwright.config.ts` starts only the web Vite server. `tests/e2e/mock-api.ts` intercepts every
`/api/*` request and returns 404 for anything a test did not explicitly mock, preventing traffic
from reaching an API server. The smoke suite therefore needs checkout, dependencies, Chromium, and
Vite—but not PostgreSQL, migrations, UAT seed data, the production web build, or the foundation
job's completion.

Moving the existing browser install and smoke commands into their own job removes a healthy 3m18s
serial tail. It does not change Playwright configuration, tests, mocks, retries, or timeouts.

## Locked design

### 1. Preserve one canonical local gate

Extract the exact existing `verify:foundation` prefix through `test:uat-seed` into one package
script named `verify:pre-integration`. Define `verify:foundation` as:

```text
pnpm verify:pre-integration && pnpm test:integration
```

`pnpm verify:foundation` remains the one supported local full gate and still runs every current
phase in the current order. The extracted prefix exists only because CI and the local gate now
share that real seam; do not create a general task runner or duplicate the command chain in YAML.

### 2. Parallelize only unit files

`scripts/test-unit.ts` must always pass Vitest's positive `--fileParallelism` option before its
resolved file arguments. Keep `vitest.config.ts` unchanged so every other invocation remains
serial by default.

Use Vitest's native automatic worker count for the MVP. Do not add a worker-count setting unless
the clean CI measurement misses the unit target below; if it does, benchmark 2, 4, and auto on the
same head and choose the fastest green bound. Explicit file invocations must retain their existing
replace-the-default behavior.

### 3. Add exactly two isolated integration jobs

Add one code-path-only matrix job with entries `1` and `2`, `fail-fast: false`, and job names that
show `1/2` or `2/2` in the Actions UI. Each entry independently performs:

1. checkout, pnpm/Node setup, and frozen dependency install;
2. `pnpm db:up`;
3. `pnpm build:app-map`, because a fresh runner has no ignored `dist/app-map.json` artifact;
4. the existing integration wrapper with the explicit filter and native shard option;
5. `if: always()` Compose teardown.

The shard command is semantically:

```text
pnpm test:integration tests/integration \
  --exclude tests/integration/release-hardening.test.ts \
  --shard=<index>/2
```

The broad suite currently includes `release-hardening.test.ts` and CI immediately reruns it through
the dedicated `test:release-hardening` command. Exclude it only from the CI shards; the unchanged
dedicated step remains required, and local `pnpm verify:foundation` continues to include it once.

Give each shard command a 15-minute GNU `timeout` deadline with the existing status-preservation
shape and a stable `CI_PHASE_TIMEOUT phase=integration-shard shard=<index>/2 budget=15m` annotation.
Give the matrix job a 20-minute hard backstop. Preserve ordinary nonzero exits exactly; no retry or
`continue-on-error`.

Do not run two integration processes in one job. That would share the PostgreSQL cluster, compete
for the cluster DDL lock, interleave logs, and save runner allocation at the cost of the isolation
this repository already built.

### 4. Shorten, but do not weaken, the existing verify job

The existing `verify` job runs `pnpm verify:pre-integration` under the current foundation timeout
wrapper, then keeps the dedicated release-hardening test, release-hardening audit, production web
build, and database cleanup in their existing order. Remove only the broad integration phase and
the two Playwright steps that now have their own jobs.

Keep the verify job's 45-minute hard cap and the existing 30-minute foundation process deadline in
this change. Re-budgeting #1534 is a later evidence-based cleanup after the new distribution has a
stable sample; a performance improvement must not reduce failure headroom in the same experiment.

### 5. Move Playwright unchanged into a database-free job

Add one code-path-only Playwright job with checkout, pnpm/Node setup, frozen dependency install,
the existing two-attempt Chromium installation body, and the existing 10-minute smoke-test timeout
body. Give the job a 25-minute hard cap so its worst allowed install attempts plus smoke deadline
fit beneath the backstop.

Do not start PostgreSQL, run migrations, run `build:web`, add caches, or change Playwright workers,
retries, mocks, or reporters in this job. `build:web` remains an independent required build check
in `verify`; Playwright continues to exercise Vite exactly as it does now.

### 6. Preserve the required-check and publication contracts

`CI gate` is the active ruleset's sole required status check. Preserve that exact job name and its
`if: always()` / `success|skipped` fail-closed behavior. Add the integration matrix job and
Playwright job to both:

- `ci-gate.needs` and its explicit result-check loop;
- `publish.needs`, because publication currently waits for the tests being moved out of `verify`.

On docs-only changes, `verify`, integration, Playwright, and both Compose jobs remain reported as
skipped; `CI gate` must still pass through its existing accepted-skips contract. On any shard or
browser failure/cancellation, `CI gate` fails and publication does not start.

GitHub documents that a dependent job waits for jobs named in `needs`; the existing `always()`
aggregate is the correct shape when some dependencies may legitimately skip:
[workflow syntax — `needs`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).

## Failure semantics

| Event                                | Required result                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Unit assertion/import/worker failure | `verify` fails with the original status; no integration/browser result can mask it.           |
| One integration shard fails          | Matrix result is red; the other shard is allowed to finish for evidence; `CI gate` fails.     |
| Integration shard exceeds 15m        | Wrapper exits 124 and emits its shard-specific timeout marker; `CI gate` fails.               |
| Browser install or Playwright fails  | Existing status and timeout semantics are preserved in the Playwright job; `CI gate` fails.   |
| Any moved job is cancelled           | Existing `CI gate` allowlist rejects `cancelled`; publication does not start.                 |
| Docs-only pull request               | All three code lanes report skipped and `CI gate` passes if the docs gate passes.             |
| Runner queue delay                   | Report separately from execution time; never hide it by weakening the acceptance measurement. |

## Acceptance

### Coverage and safety

- [ ] `pnpm verify:foundation` still expands to the same checks and full integration selection in
      the same order; no test is removed from the canonical local gate.
- [ ] Unit parallelism is applied inside `scripts/test-unit.ts` and cannot drop the `tests/unit`
      scope when the command has no explicit files.
- [ ] The union of integration shard file lists equals the unsharded `tests/integration` list
      minus `release-hardening.test.ts`, with no overlap and no missing file.
- [ ] The dedicated release-hardening step runs exactly once in CI and remains green.
- [ ] Each integration shard log proves a unique non-default database and successful cleanup.
- [ ] No shard shares a runner or PostgreSQL cluster with another shard.
- [ ] `CI gate` and `publish` both depend on `verify`, integration, Playwright, and the unchanged
      deployment-smoke jobs. The required check is still named exactly `CI gate`.
- [ ] A docs-only PR still produces a green `CI gate` with all code-path jobs reported skipped.
- [ ] No test skip/filter beyond the named duplicate, retry, assertion-timeout increase,
      `continue-on-error`, changed-file selection, or failure waiver is introduced.

### Performance proof

Measure at least five fresh green code-path CI runs after the final implementation commit. Record
queued and execution time separately, plus each lane/step duration, file count, test count, and
integration shard skew.

- [ ] Median required verification critical path—from the code-path jobs starting through
      `CI gate` completion—is **12m00s or less**.
- [ ] Median unit-test duration is **2m00s or less**.
- [ ] Median slowest integration shard is **12m00s or less**.
- [ ] No accepted run exceeds 18 minutes of execution without a named external infrastructure
      incident; ordinary variance is not a reason to raise a deadline.
- [ ] All five runs have identical discovered file/test coverage for the same source head and no
      new flaky rerun pattern.

If the critical-path median misses 12 minutes, report the measured bottleneck before changing the
design. Allowed next probes are a bounded unit `maxWorkers` comparison and inspection of two-shard
skew. More shards, custom sequencing, test rewrites, or caching require a follow-up decision.

### Repository verification

- [ ] Focused unit tests cover the unit wrapper's default, explicit-path, and internal parallel
      option behavior.
- [ ] Workflow YAML is formatted and reviewed for exact `needs`, condition, timeout, and cleanup
      semantics.
- [ ] The full local gate is run only through the repository's verify-gate procedure against an
      isolated database and is green at the final head.
- [ ] The implementation PR's current-head `CI gate` is green before any benchmark reruns count.

## Rollback and kill gates

Any cross-shard database collision, missing test file, new concurrency-only failure, green
`CI gate` after a moved lane fails, or publication beginning before all moved lanes pass is an
immediate kill gate. Do not rerun until green, add retries, or raise timeouts to force acceptance.

Rollback is workflow/package composition only: restore integration and Playwright to `verify`,
restore the original `verify:foundation` chain, and remove the new dependencies. Unit-only
parallelism may remain only if its clean-head results are independently green and scope-correct.
No application or database rollback exists because this design changes neither.

## Explicit non-goals

- No application, production database, migration, RLS, module, or user-facing behavior change.
- No global `fileParallelism: true`; integration files remain serial within each database.
- No same-runner integration concurrency, third shard, custom sequencer, or blob-report merge.
- No pool/isolation change and no test-level transaction/template-database rewrite.
- No changed-file test selection, test deletion, skipped coverage, retry, or timeout relaxation.
- No new dependency, cache action, persistent `node_modules` cache, or generated timing service.
- No Compose-smoke, production-smoke, image-build, or remote ruleset redesign.
- No PR-run cancellation/concurrency policy change; that reduces wasted work, not one run's
  critical path, and must not affect `main` or tag publication accidentally.
- No #1534 timeout reduction until the new execution distribution has stable evidence.

## Process notes

- This is internal tooling, routine risk, and has no live user path; the live-path UI gate does not
  apply.
- The research note is the source ledger for primary documentation and the raw performance
  breakdown. This spec owns the decisions.
- Fable review happens before the implementation plan. The plan must re-ground file lines and
  `origin/main`, name the tracking task, and preserve every locked failure/rollback condition here.
