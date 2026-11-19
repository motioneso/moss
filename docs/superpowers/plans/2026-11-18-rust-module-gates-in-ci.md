# Run the Rust module package gates in CI

JS-349, plan only. Finding from PR 4364: a Finance bank-sync data-loss bug reached `main` because no
workflow runs any of the 75 `test:rust-*` scripts in `package.json`.

## Why CI misses them today

- `.github/workflows/ci.yml:90` marks a change as `rust_only` when every path is under `modules/*/`,
  `rust-spike/` or docs. `unit` and `browser` then skip (`ci.yml:182`, `ci.yml:313`).
- `verify`, `integration` and the compose smokes still run, but none of them builds a module package
  or calls a module gate.
- `rust-calendar.yml` is the only module workflow. It runs Calendar's `check.sh` (no database), is
  not in `ci-gate`'s `needs` list (`ci.yml:500-501`), so it cannot block a merge.
- The Finance bug was caught only by `modules/finance/host/tests/installed.rs:404`, a test that
  loads the real Wasm package into the real host against Postgres. A no-database `check.sh` tier
  would not have caught it. The per-PR tier therefore has to include the database-backed suites.

## Seams (verified in the tree)

| Capability                                            | Evidence                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A gate can run in an isolated throwaway Postgres      | `scripts/run-gate.sh:289-313` (`docker run` pgvector), `:623` exports `JARVIS_GATE_RUN=1`       |
| Every module gate refuses to run outside that wrapper | e.g. `modules/finance/tools/gate.ts:3`, `modules/finance/tools/check.sh:4`                      |
| Gates run offline from a fetched registry             | `--locked --offline` in every module `check.sh`; `rust-calendar.yml` fetches first              |
| Hosted runners can already run Docker Postgres        | `ci.yml` `integration` job, `pnpm db:up`                                                        |
| All 17 module hosts pin one wasmtime                  | every `modules/*/host/Cargo.lock`: wasmtime 38.0.4                                              |
| Every module depends on the shared host crates        | `modules/*/**/Cargo.toml` path deps on `rust-spike/module-host`, `module-sdk`, `access-context` |
| Disk-lean cargo settings already used in CI           | `rust-local-locks.yml:24-31` (`CARGO_HOME`, `CARGO_INCREMENTAL=0`, debug 0)                     |
| No workflow caches cargo today                        | no `actions/cache` in `.github/workflows/`                                                      |

Open question (owner: the build task for rollout step 1): `run-gate.sh` has never run on a hosted
runner. It assumes Docker, a free local port and `/tmp`. Step 1 proves it or swaps in a service
container.

## Gate tiers

### Every PR that touches a module (required)

Trigger paths per module `<m>`: `modules/<m>/**`, `packages/<m>/sql/**`.
Runs the module's own non-live gate through `scripts/run-gate.sh start --gate <script>` then
`wait --follow` under a job timeout.

| Module                                                                                                        | Scripts                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| tasks                                                                                                         | `test:rust-tasks`                                                               |
| people                                                                                                        | `test:rust-people-large` (needs a prebuilt component, see below)                |
| notes                                                                                                         | `modules/notes/tools/gate.sh` (needs prebuilt components, see below)            |
| calendar                                                                                                      | `test:rust-calendar-server` (folds in `rust-calendar.yml`'s `check.sh`)         |
| finance                                                                                                       | `test:rust-finance`, `test:rust-finance-ui-unit`                                |
| wellness                                                                                                      | `test:rust-wellness`                                                            |
| memory                                                                                                        | `test:rust-memory`, `test:rust-memory-index`, `test:rust-memory-oracle`         |
| meetings                                                                                                      | `test:rust-meetings`, `test:rust-meetings-oracle`, `test:rust-recording-oracle` |
| news                                                                                                          | `test:rust-news`, `test:rust-news-reader`                                       |
| briefings, sports, weather, web-research, goals, meals, commitments, backtrack, scratchpad, connectors, email | `test:rust-<m>`                                                                 |

`test:rust-memory-recording` is a subset of `test:rust-memory` and is not run separately.
`test:rust-tasks-privacy` and `test:rust-tasks-jobs` are inner steps of `test:rust-tasks`; run
alone, `tasks-privacy` exits 1 by design (`modules/tasks/tools/tests/privacy.rs:214`, `TASKS_COMPONENT`).

Notes and People are the only modules whose gates do not build their own component. Notes'
`gate.sh:9` needs `NOTES_COMPONENT` and `NOTES_TOOL_COMPONENT`; `test:rust-notes-server`,
`test:rust-notes-ingest` and `test:rust-people-large` (`JS50_PEOPLE_COMPONENT`,
`rust-spike/module-host/tools/people-gate.ts:10`) exit 1 without them. Until a fix task makes
them self-building, the CI job runs each module's `tools/build-component.sh` first, as the module
READMEs do.
`test:rust-wellness-fixtures` is a TypeScript integration test and already runs in the
`integration` job, which runs all of `tests/integration` (`ci.yml:296`).

### Shared host change (PR runs host gates; full module matrix runs on main)

Trigger paths: `rust-spike/module-host/**`, `module-sdk/**`, `access-context/**`, `safety-core/**`,
`module-ui/**`, `network/**`, `standins/**`, `vault/**`, `parity/**`, `ui/bindgen/**`.

- On the PR: `test:rust-module-bootstrap`, `-install-endpoints`, `-module-assembly`, `-public-web`,
  `-tasks-server`, `-people-server`, `-proactive-server`, `-proactive-feedback`,
  `-weather-preferences`, `-module-ai`, `-integrations`, `-standins`.
- On the push to `main`: every module gate above.
- Rejected option: the whole module matrix on every host PR. It catches a host break before merge,
  but it fans out to about 20 jobs of 5 to 20 minutes each and starves the free plan's concurrent
  jobs for every other PR. A red `main` push opens a fix task the same hour, which is the cheaper
  trade while host PRs are frequent.

### Nightly on `main`

- The full matrix (module and host gates).
- The `-live` gates that use stand-ins only: `briefings`, `sports`, `weather`, `web-research`,
  `news`, `goals`, `meals`, `commitments`, `wellness`, `finance` (fake bank), `backtrack`,
  `scratchpad`, `meetings`, `memory`, `email`, `connectors` (fake Google, Outlook, mail). Each is
  promoted only after one run proves it needs no real account. Several read a non-loopback network
  address (`modules/finance/tools/live-gate.ts:13-16`), which hosted runners have.

### Local only

| Script                                                                       | Why                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `test:rust-plaid-live`, `test:rust-finance-plaid-live`                       | real Plaid account                                |
| `test:rust-integrations-live`, `test:rust-browser-live`                      | real services or a real browser session           |
| `test:rust-email-greenmail-live`                                             | separate mail server; candidate for nightly later |
| `test:rust-tasks-ui`, `test:rust-wellness-ui`, `test:rust-finance-ui`        | interactive: wait for a person to click through   |
| `test:rust-linux-*`, `test:rust-click-live`, `test:rust-app-runtime-routing` | desktop session and installed app                 |
| `*-oracle-write`                                                             | rewrite fixtures; never in CI                     |

## Keeping time and disk sane

- **Path filter.** Extend the `changes` job to emit a JSON list of touched modules and a
  `host_changed` flag. One `rust-modules` job runs a matrix over that list, `fail-fast: false`.
- **Toolchain.** `rustup toolchain install 1.95.0 --profile minimal --target wasm32-unknown-unknown`,
  as `rust-calendar.yml` does.
- **Cargo home.** `CARGO_HOME: ${{ github.workspace }}/.cargo-home`. Cache it with
  `actions/cache`, key on `hashFiles('modules/<m>/**/Cargo.lock', 'rust-spike/**/Cargo.lock')`.
- **Target cache.** One target folder per module, cached on module + lockfile hash, restore-key
  on the shared host lock. Because all hosts pin the same wasmtime, a nightly warm job that builds
  `rust-spike/module-host` saves a shared seed every module job restores first.
- **Shared Wasm build.** The nightly warm job also builds the shared screen assets
  (`rust-spike/module-ui/build-assets.py`) and `rust-spike/ui/bindgen` once and uploads them as an
  artifact for live gates. The per-module component build stays inside each gate, because the gate
  must test the bytes it built.
- **Disk.** `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0`, as
  `rust-local-locks.yml` does. Print `df -h` before and after the gate so the first runs measure
  headroom. Measured cold target folders: Finance 3.2 GB, Tasks 2.4 GB.

### Measured run time

Local box, 16 cores, shared with other work (load about 9), one gate at a time, through
`scripts/run-gate.sh`.

MEASURED_TABLE

Most of each gate is test run time, not compiling. Finance's installed suite alone ran 494 s with
`--test-threads=1`, and its guard-removal controls about 4 minutes. A cache cannot shrink that.

Real CI reference: `rust-calendar.yml` runs Calendar's `check.sh` uncached in 6 to 8 minutes wall
time on `ubuntu-latest`, about 50 s of it setup (last six runs, 2026-11-18).

Estimate per module job on a hosted runner: setup 1 min, plus the local warm time, plus up to
100% for compiling on 4 cores when the cache misses. Finance is the worst case at about 22 to
30 minutes. Today's full CI on `main` takes 20 to 25 minutes, so Finance becomes the long pole.

## Red on `main` today

Run once each on `main` at `535431302`, clean tree, through `scripts/run-gate.sh`. Each failure
becomes its own fix task; none is fixed here.

RED_TABLE

## Rollout

1. **Fix the red gates** (one task each, above). Nothing becomes required while its gate is red.
2. **Shadow job, two modules.** Add `rust-modules` with Finance and Tasks only, not in `ci-gate`'s
   `needs`. Proves `run-gate.sh` on a hosted runner, the caches and the disk headroom.
3. **All modules, still shadow.** Extend the matrix. Delete `rust-calendar.yml` once Calendar runs
   in the matrix.
4. **Required.** Add `rust-modules` to `ci-gate`'s `needs` and result loop (`ci.yml:500-512`).
   Skipped stays a pass, so a PR that touches no module is unaffected.
5. **Host gates on PR, matrix on main push.**
6. **Nightly** full matrix plus stand-in live gates, one live gate promoted at a time.

## Kill gate

Owner: the CI rollout coordinator. Observe after step 3, over the first ten PRs that run the job.

- If any module job's median wall time exceeds **30 minutes**, that module's per-PR tier drops its
  guard-removal controls and slowest installed suite to the `main` push; the PR keeps the rest.
- If the median `rust-modules` wall time for a single-module PR exceeds **25 minutes** after that,
  stop at shadow mode and bring the measurements back to Ben before making it required.
- If a cached run still runs out of disk, split the module's suites across two jobs.

## Verification for each build step

```bash
scripts/run-gate.sh start --gate test:rust-finance
scripts/run-gate.sh wait --follow --log <path printed by start>; echo "EXIT=$?"
```

Expected `EXIT=0` on a green module, `EXIT=1` on a red one. In CI, the job's `timeout-minutes`
bounds the wait.
