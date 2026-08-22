# Verify foundation and app — CI performance research

**Date:** 2026-08-22  
**Question:** Is the current `Verify foundation and app` job healthy, and what is the smallest safe
change that materially reduces its wall time?

## Conclusion

The investigated run is healthy: [run 32555181757, job
96988119981](https://github.com/motioneso/moss/actions/runs/32555181757/job/96988119981)
completed successfully. It is slow because independent work is serialized, not because the job is
stuck.

| Observed phase          | Wall time | Share of 24m55s foundation step |
| ----------------------- | --------: | ------------------------------: |
| Unit tests              |     5m22s |                             22% |
| UAT seed tests          |       12s |                              1% |
| Integration tests       |    17m03s |                             68% |
| Other foundation checks |    ~2m18s |                              9% |

The entire job took 29m56s. After foundation, it also spent 28s rerunning release hardening, 29s
installing Chromium dependencies, and 2m49s running Playwright.

The highest-value shape is therefore three concurrent lanes after change classification:

1. existing non-integration verification, with unit-file parallelism enabled and bounded;
2. a two-entry integration matrix, one isolated runner/database per shard;
3. the existing Playwright smoke suite in its own job.

The measured unit experiment can save about four minutes by itself. Two integration shards have an
ideal lower bound near half of 17 minutes, but Vitest balances file counts rather than historical
duration, so the real result must be measured. Parallelizing the 3m18s browser tail means a
reasonable first target is **12 minutes or less for the required verification critical path**, not
a guaranteed estimate. Do not add more than two integration shards until timing proves the first
split is balanced and useful.

## Repository facts that constrain the design

- One `verify` job currently owns dependency install, database startup, all foundation checks,
  release hardening, the web build, and Playwright. Every step in a job runs serially
  ([`.github/workflows/ci.yml:94-175`](../../.github/workflows/ci.yml#L94-L175)).
- `verify:foundation` is itself one `&&` chain ending in unit, migration, UAT seed, and integration
  tests ([`package.json:28`](../../package.json#L28)). This hides phase timing inside one Actions
  step and prevents independent lanes from overlapping.
- The shared Vitest configuration selects `forks` and globally sets `fileParallelism: false`
  ([`vitest.config.ts:330-343`](../../vitest.config.ts#L330-L343)). This serializes unit files even
  though the database-sharing reason applies to integration tests.
- The unit wrapper defaults to `tests/unit` only when it receives no arguments
  ([`scripts/test-unit.ts:5-18`](../../scripts/test-unit.ts#L5-L18)). Therefore passing only
  `--fileParallelism` on its command line accidentally removes the unit directory filter and lets
  Vitest collect every configured suite. The override belongs inside the wrapper (or must be
  invoked with an explicit `tests/unit` filter).
- The integration wrapper creates and later drops a unique database per invocation
  ([`scripts/test-integration.ts:15-24`](../../scripts/test-integration.ts#L15-L24),
  [`scripts/test-integration.ts:96-114`](../../scripts/test-integration.ts#L96-L114)). It already
  provides the isolation needed for one invocation per matrix runner.
- The same argument caveat applies to integration sharding: `pnpm test:integration --shard=1/2`
  drops the default `tests/integration` filter because any CLI argument replaces the default
  ([`scripts/test-integration.ts:26-36`](../../scripts/test-integration.ts#L26-L36)). A safe current
  invocation is `pnpm test:integration tests/integration --shard=1/2`.
- Integration resets perform cluster-global role DDL about 100 times per gate and deliberately
  serialize it behind a cluster-wide lock
  ([`tests/integration/test-database.ts:71-97`](../../tests/integration/test-database.ts#L71-L97)).
  Running shards concurrently against one PostgreSQL cluster would contend on that lock. Separate
  GitHub-hosted matrix jobs each get their own runner and Compose cluster, so they do not share this
  bottleneck.
- The full integration selection includes `release-hardening.test.ts`, then the workflow runs that
  file again through `test:release-hardening`
  ([`package.json:58-69`](../../package.json#L58-L69),
  [`.github/workflows/ci.yml:122-135`](../../.github/workflows/ci.yml#L122-L135)). The duplicate cost
  was 23s inside the suite plus 27s as the dedicated rerun; removing it is low priority beside
  sharding.
- Playwright starts its own Vite development server
  ([`playwright.config.ts:19-24`](../../playwright.config.ts#L19-L24)), and its shared API harness
  rejects unmocked `/api/*` traffic rather than contacting a backend
  ([`tests/e2e/mock-api.ts:161-169`](../../tests/e2e/mock-api.ts#L161-L169)). The browser lane does not
  need the foundation job's PostgreSQL container or production web build and can run independently.
- `CI gate` is already the single stable required-check aggregate and uses `if: always()` to inspect
  conditional dependencies ([`.github/workflows/ci.yml:280-310`](../../.github/workflows/ci.yml#L280-L310)).
  Preserve that check name; add new lane results to its `needs` list and fail-closed loop. `publish`
  must also wait for every lane that used to live inside `verify`
  ([`.github/workflows/ci.yml:312-316`](../../.github/workflows/ci.yml#L312-L316)).

## What Vitest officially supports

| Feature          | Primary-source fact                                                                                                                                                                                                                       | Implication here                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| File parallelism | `fileParallelism` defaults to `true`; disabling it forces `maxWorkers` to `1`. It controls files, not tests within one file. [Vitest config](https://vitest.dev/config/fileparallelism)                                                   | Keep the safe global default, but override it only in the unit wrapper.                                             |
| CLI precedence   | In Vitest 4.1.8, final test config is merged first and CLI `options` last. [Vitest 4.1.8 source](https://github.com/vitest-dev/vitest/blob/v4.1.8/packages/vitest/src/node/plugins/index.ts#L222-L224)                                    | A unit-only CLI override can supersede the global `false` without a second config file.                             |
| Worker bound     | In run mode `maxWorkers` defaults to all available parallelism, accepts a number or percentage, and uses Node `os.availableParallelism()`. [Vitest config](https://vitest.dev/config/maxworkers)                                          | Benchmark a small explicit bound against auto; do not assume the runner's maximum is fastest.                       |
| Sharding         | `--shard=<index>/<count>` splits **test files**, not cases, into equal-count groups. It cannot run in watch mode. [CLI](https://vitest.dev/guide/cli#shard), [performance guide](https://vitest.dev/guide/improving-performance#sharding) | Start with `1/2` and `2/2`; inspect shard skew because several integration files take 20-30s each.                  |
| Ordering         | Sharding happens before sorting. A custom sequencer must implement both `shard` and `sort`. [Vitest sequence config](https://vitest.dev/config/sequence#sequence-sequencer)                                                               | Use the built-in sequencer for the MVP; no custom duration-balancer yet.                                            |
| Reports          | Blob reports can be uploaded and merged after shards. Blob and merge-report modes do not work in watch mode. [Vitest reporters](https://vitest.dev/guide/reporters#blob-reporter)                                                         | Normal per-shard logs are enough initially. Add artifact upload/merge only if a combined report is actually needed. |
| Other tuning     | `vitest doctor` benchmarks pool, isolation, and lower worker counts; Vitest notes that too many workers can bottleneck on the single Vite server. [Vitest CLI](https://vitest.dev/guide/cli#vitest-doctor)                                | Use it as a bounded benchmark after the structural changes, not as a reason to change pool/isolation speculatively. |

Relevant shard constraints from the CLI are: positive `count`, positive `index`, and
`index <= count`; current `vitest run` usage already satisfies the no-watch requirement. The
repository has no custom sequencer.

## What GitHub Actions officially supports

- A matrix creates one job per combination, and `strategy.max-parallel` can cap simultaneous jobs.
  Matrix `fail-fast` defaults to `true`.
  [GitHub matrix jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)
- A job named in `needs` waits for all required jobs; a failed or skipped dependency normally skips
  downstream jobs unless their condition explicitly keeps them running. The existing `CI gate`
  already uses the correct `always()` aggregation pattern.
  [GitHub workflow syntax — `needs`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)
- Required checks must report on the latest commit. Skipping an entire required workflow through
  path/branch filtering can leave it pending, while a conditionally skipped job reports success.
  Keeping the existing unconditional `CI gate` name avoids branch-protection churn.
  [GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- Runs execute concurrently by default. A `concurrency` group with `cancel-in-progress` can cancel a
  superseded PR run, reducing queue pressure and wasted compute; it does not make one run faster and
  should not broadly cancel main/tag publication.
  [GitHub concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- `actions/setup-node` package-manager caching stores global package data, not `node_modules`.
  This workflow already enables `cache: pnpm`, and dependency installation took only 13s in the
  investigated run, so another dependency-cache design has little payoff.
  [`setup-node` caching](https://github.com/actions/setup-node#caching-global-packages-data)
- Job summaries can expose concise timing/results through `$GITHUB_STEP_SUMMARY`; separate lane and
  phase steps also receive native timestamps in the Actions UI.
  [GitHub workflow commands — job summaries](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary)

## Recommended scope for the spec

### MVP

1. Enable file parallelism only in `scripts/test-unit.ts`; benchmark `maxWorkers=2`, `4`, and auto on
   the GitHub-hosted runner, then keep the fastest stable bound.
2. Split integration into a two-entry matrix using
   `pnpm test:integration tests/integration --shard=<index>/2`. Give each entry the existing
   database startup/cleanup and a bounded integration timeout.
3. Move Playwright install/smoke into its own independent job without PostgreSQL startup.
4. Keep `CI gate` as the required aggregate, add both new lane results to its fail-closed check, and
   make `publish` wait for them.
5. Record lane durations and test/file counts for at least five green main runs. Acceptance should
   require identical suite coverage and no increase in rerun/flaky-failure rate.

### Explicitly defer

- more than two integration shards;
- a custom duration-aware sequencer;
- same-runner concurrent integration processes;
- `isolate: false`, a pool change, or persistent module caching without a `vitest doctor` benchmark;
- blob artifact merge unless one combined report is requested;
- new cache actions or dependencies;
- test-selection-by-changed-files, which would weaken the foundation gate rather than accelerate the
  same coverage.

The dedicated release-hardening duplicate and PR-only stale-run cancellation are safe follow-ups,
but neither should delay the three structural changes above.
