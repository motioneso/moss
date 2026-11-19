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

Open question (owner: the build task for rollout step 2): `run-gate.sh` has never run on a hosted
runner. It assumes Docker, a free local port and `/tmp`. Step 2 proves it or swaps in a service
container. Each job must also set `RUSTUP_HOME`, as `rust-local-locks.yml:24-25` does. Five host
gates failed in about a minute here until the sweep set it, then passed.

## Gate tiers

### Every PR that touches a module (required)

Trigger paths per module `<m>`: `modules/<m>/**`, `packages/<m>/sql/**`.
Runs the module's own non-live gate through `scripts/run-gate.sh start --gate <script>` then
`wait --follow` under a job timeout.

| Module                                                                                                        | Scripts                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| tasks                                                                                                         | `test:rust-tasks`                                                               |
| people                                                                                                        | `test:rust-people-large` (needs a prebuilt component, see below)                |
| notes                                                                                                         | `modules/notes/tools/gate.sh`, `test:rust-notes-server`, `-notes-ingest` (S1)   |
| calendar                                                                                                      | `modules/calendar/tools/gate.sh`, `test:rust-calendar-server` (S2)              |
| finance                                                                                                       | `test:rust-finance`, `test:rust-finance-ui-unit`                                |
| wellness                                                                                                      | `test:rust-wellness`                                                            |
| memory                                                                                                        | `test:rust-memory`, `test:rust-memory-index`, `test:rust-memory-oracle`         |
| meetings                                                                                                      | `test:rust-meetings`, `test:rust-meetings-oracle`, `test:rust-recording-oracle` |
| news                                                                                                          | `test:rust-news`, `test:rust-news-reader`                                       |
| briefings, sports, weather, web-research, goals, meals, commitments, backtrack, scratchpad, connectors, email | `test:rust-<m>`                                                                 |

`test:rust-memory-recording` is a subset of `test:rust-memory` and is not run separately.
`test:rust-tasks-privacy` and `test:rust-tasks-jobs` are inner steps of `test:rust-tasks`; run
alone, `tasks-privacy` exits 1 by design (`modules/tasks/tools/tests/privacy.rs:214`, `TASKS_COMPONENT`).

Five gates do not build what they test. Notes and People are the only modules whose main gate
needs components prebuilt, and `test:rust-calendar-server` needs `JS181_CALENDAR_PACKAGE` and
`JS220_TASKS_PACKAGE` (`modules/calendar/tools/server-gate.ts:8-15`). Notes'
`gate.sh:9` needs `NOTES_COMPONENT` and `NOTES_TOOL_COMPONENT`; `test:rust-notes-server`,
`test:rust-notes-ingest` and `test:rust-people-large` (`JS50_PEOPLE_COMPONENT`,
`rust-spike/module-host/tools/people-gate.ts:10`) exit 1 without them. Until a fix task makes
them self-building, the CI job runs each module's `tools/build-component.sh` first, as the module
READMEs do.
`test:rust-wellness-fixtures` is a TypeScript integration test and already runs in the
`integration` job, which runs all of `tests/integration` (`ci.yml:296`).

### Shared host change (PR runs host gates; full module matrix runs on main)

Trigger paths: `rust-spike/module-host/**`, `module-sdk/**`, `access-context/**`, `safety-core/**`,
`module-ui/**`, `network/**`, `standins/**`, `vault/**`, `parity/**`, `ui/bindgen/**`,
`infra/postgres/migrations/**`, `scripts/run-gate.sh`.

- On the PR: `test:rust-module-bootstrap`, `-install-endpoints`, `-module-assembly`, `-public-web`,
  `-tasks-server`, `-people-server`, `-proactive-server`, `-proactive-feedback`,
  `-weather-preferences`, `-module-ai`, `-integrations`, `-standins`, plus Calendar's
  `modules/calendar/tools/check.sh`, which keeps what `rust-calendar.yml:4-10` covers today.
  `-people-server`, `-module-bootstrap` and `-install-endpoints` wait on S2, and
  `-weather-preferences` on R6.
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
- **Cache budget.** GitHub keeps 10 GB of cache per repository and evicts the oldest past that.
  Seventeen module target folders of 2.4 to 3.2 GB would evict each other, so the budget is:
  - one shared Cargo home (`CARGO_HOME: ${{ github.workspace }}/.cargo-home`), keyed on
    `hashFiles('modules/**/Cargo.lock', 'rust-spike/**/Cargo.lock')`;
  - one shared host seed, built nightly from `rust-spike/module-host`. All hosts pin the same
    wasmtime, so every module job restores it as its starting target folder;
  - no per-module target cache. Step 2 measures the miss cost on Finance and Tasks before any
    module earns one.
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

Cold runs (fresh target folder, load about 9):

| Gate                | Result | Wall time | Target folder |
| ------------------- | ------ | --------- | ------------- |
| `test:rust-finance` | pass   | 21 min    | 3.2 GB        |
| `test:rust-tasks`   | red    | 13 min    | 2.4 GB        |

Finance ran again at the end of the sweep, reusing a shared target folder at load 30 to 55. It
passed in 32 minutes.

Sweep runs (two lanes in parallel, each lane reusing one target folder, load 30 to 55 from other
work on the box). Treat these as upper bounds.

| Gate                      | Wall time                              | Gate                           | Wall time    |
| ------------------------- | -------------------------------------- | ------------------------------ | ------------ |
| `test:rust-memory`        | over 90 min (stopped, 42 tests green)  | `test:rust-goals`              | 8 min        |
| `test:rust-news`          | 44 min                                 | `test:rust-wellness`           | 8 min        |
| `test:rust-meals`         | 36 min                                 | `test:rust-proactive-server`   | 8 min        |
| `test:rust-meetings`      | 33 min                                 | `test:rust-module-assembly`    | 5 min        |
| `test:rust-sports`        | 30 min                                 | `test:rust-tasks-server`       | 4 min        |
| `test:rust-tasks` (rerun) | 16 min                                 | `test:rust-module-ai`          | 4 min        |
| `test:rust-briefings`     | 12 min                                 | `test:rust-proactive-feedback` | 3 min        |
| `test:rust-scratchpad`    | 2 min                                  | `test:rust-memory-index`       | 3 min        |
| `test:rust-web-research`  | 2 min                                  | `test:rust-public-web`         | 2 min        |
| `test:rust-commitments`   | 2 min                                  | `test:rust-weather`            | 1 min        |
| `test:rust-connectors`    | over 90 min (stopped, 192 tests green) | Calendar `gate.sh`             | 11 min (red) |
| `test:rust-email`         | 9 min                                  | `test:rust-integrations`       | 4 min        |
| `test:rust-standins`      | 2 min                                  |                                |              |

Connectors' time is one test. `one_sync_step_fits_the_manifest_budget_at_every_mailbox_size`
(`modules/connectors/host/tests/sync_speed.rs`) ran 55 minutes alone. It belongs in the nightly
tier, not the per-PR tier, so Connectors' gate needs a switch to skip it on PRs.

Two shared target folders reached 22 GB and 11 GB across the sweep. A hosted runner cannot hold
one target folder shared across modules, so each module job keeps its own.

Most of each gate is test run time, not compiling. Finance's installed suite alone ran 494 s with
`--test-threads=1`, and its guard-removal controls about 4 minutes. A cache cannot shrink that.

Real CI reference: `rust-calendar.yml` runs Calendar's `check.sh` uncached in 6 to 8 minutes wall
time on `ubuntu-latest`, about 50 s of it setup (last six runs, 2026-11-18).

Estimate per module job on a hosted runner: setup 1 min, plus the local time, plus up to 100%
for compiling on 4 cores when the cache misses. Most modules land at 5 to 25 minutes. Finance's
cold run (21 min at low load) is the best measured large case.

Memory, News, Meals, Meetings, Sports and Finance ran 30 minutes or more locally (Finance in its
second run). Their tests run one at a time against Postgres (`--test-threads=1`), so more cores do
not help. Run each of those six as one matrix job per test file from the first rollout step that includes them. That needs
a suite filter in each of those gates, as People's gate already has (`JS50_PEOPLE_SUITE`,
`modules/people/README.md:115`). Memory's files alone measured 45, 20 and 19 minutes for `installed`,
`recording` and `reembed`. That is a floor, because the run was stopped at 90 minutes with
files still left.

Today's full CI on `main` takes 20 to 25 minutes, so the split modules set the long pole.

## Red on `main` today

Run once each on `main` at `535431302`, clean tree, through `scripts/run-gate.sh`. Each failure
becomes its own fix task; none is fixed here.

Real failures, one fix task each:

| #   | Gate                            | Failure                                                                                                                                                       | Evidence                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1  | `test:rust-tasks`               | With row security removed, the briefing read still shows the second account nothing, so the removal control never goes red. Failed 2 of 2 runs.               | `modules/tasks/tools/tests/privacy/briefing.rs:48`                                                                        |
| R2  | `test:rust-backtrack`           | Installed test does not compile: missing field `browser_dir`, added to the host by #4287.                                                                     | `modules/backtrack/host/tests/support/install.rs:81`                                                                      |
| R3  | `test:rust-news-reader`         | The reader's own privacy check forbids in-source tests; #4285 added a `#[cfg(test)]` block.                                                                   | `modules/news/reader/tests/privacy.rs:86`, `modules/news/reader/src/html.rs:203`                                          |
| R4  | `test:rust-recording-oracle`    | Old-code output no longer matches the stored cases (last written by #4244), from the first scenario. Cause not traced.                                        | `modules/meetings/tools/recording-oracle.ts:477`                                                                          |
| R5  | `test:rust-news`                | Overview returns no stories for a stored page. Likely the fixed 2026-11-11 story dates aged out of a seven-day window; not traced.                            | `modules/news/host/tests/installed.rs:580`                                                                                |
| R6  | `test:rust-weather-preferences` | The checked-in Weather declaration lists 2 resources; the host binds 3.                                                                                       | `rust-spike/module-host/tests/weather_preferences_database.rs:56`, `rust-spike/module-host/src/account_preferences.rs:92` |
| R7  | Calendar `gate.sh`              | Installed test installs Calendar alone; the manifest requires Tasks since #4224, so install fails with "A required module is missing or incompatible: tasks". | `modules/calendar/host/tests/installed.rs:103`, `modules/calendar/moss.module.json:185-186`                               |

Setup gaps, not test failures. Each becomes a fix task too, because CI cannot run these gates
until it is closed:

| #   | Gates                                                                                    | Gap                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| S1  | Notes `gate.sh`, `test:rust-notes-server`, `-notes-ingest`, `-people-large`              | Need a prebuilt component; every other module's gate builds its own.                  |
| S2  | `test:rust-people-server`, `-module-bootstrap`, `-install-endpoints`, `-calendar-server` | Need a hand-packed module package (`modules/people/README.md:200-214`). Not run here. |

Seen once and not counted: `search::compiled_search_uses_saved_account_day_in_prompt` in
`test:rust-tasks` hit "Module rollback deadline exceeded" at load about 50 and passed in the cold
run. A gate that runs on a shared runner needs that deadline checked under load (owner: R1's
fix task).

Expected non-zero exits, by design: `test:rust-tasks-privacy` run alone, and the interactive
`-tasks-ui` and `-wellness-ui` gates, stopped once they started.

## Rollout

1. **Fix the red gates and setup gaps** (R1-R7, S1-S2, one task each). Nothing becomes required
   while its gate is red. Add the suite filter to Memory, News, Meals, Meetings, Sports and
   Finance, and a PR-skip switch for Connectors' `sync_speed` test.
2. **Shadow job, two modules.** Add `rust-modules` with Finance and Tasks only, not in `ci-gate`'s
   `needs`. Proves `run-gate.sh` on a hosted runner, the caches and the disk headroom.
3. **All modules, still shadow.** Extend the matrix.
4. **Required.** Add `rust-modules` to `ci-gate`'s `needs` and result loop (`ci.yml:500-512`).
   Skipped stays a pass, so a PR that touches no module is unaffected.
5. **Host gates on PR, matrix on main push.** Needs S2 and R6 closed. Delete `rust-calendar.yml`
   here, once host PRs run Calendar's `check.sh`.
6. **Nightly** full matrix plus stand-in live gates, one live gate promoted at a time.

## Kill gate

Owner: the CI rollout coordinator. Observe after step 3, over the first ten PRs that run the job.

- If any module job's median wall time exceeds **30 minutes** after the per-file split, that
  module's per-PR tier drops its guard-removal controls and slowest test file to the `main` push;
  the PR keeps the rest. Memory is the likely first case.
- If any job's median still exceeds 30 minutes after that, stop at shadow mode and bring the
  measurements back to Ben before making it required. One limit applies throughout: 30 minutes
  per job, measured on the slowest job a PR waits for.
- If a cached run still runs out of disk, split the module's suites across two jobs.

## Verification for each build step

```bash
scripts/run-gate.sh start --gate test:rust-finance
scripts/run-gate.sh wait --follow --log <path printed by start>; echo "EXIT=$?"
```

Expected `EXIT=0` on a green module, `EXIT=1` on a red one. In CI, the job's `timeout-minutes`
bounds the wait.
