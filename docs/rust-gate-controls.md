# Rust module gate controls

Run database gates from the repository root through `scripts/run-gate.sh`, following the
`verify-gate` skill. Set `CARGO_HOME` and a scratch `CARGO_TARGET_DIR` before starting a gate.

These selectors choose one database test file. Leave them unset (or empty) to retain the full
gate and its existing test order. Unknown non-empty suite names fail before building.
Builds, native tests, oracles and package checks still run as prerequisites.

| Gate                 | Selector         | Database suites, in default order                                                                      |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `test:rust-memory`   | `MEMORY_SUITE`   | `db`, `dashboard`, `recording`, `reembed`, `account`                                                   |
| `test:rust-news`     | `NEWS_SUITE`     | `installed`                                                                                            |
| `test:rust-meals`    | `MEALS_SUITE`    | `installed`                                                                                            |
| `test:rust-meetings` | `MEETINGS_SUITE` | `installed`, `outputs`, `recording`, `transcripts`, `exports`, `reading`, `ring`, `capture`, `devices` |
| `test:rust-sports`   | `SPORTS_SUITE`   | `installed`                                                                                            |
| `test:rust-finance`  | `FINANCE_SUITE`  | `installed`, `part25`                                                                                  |

For example, with the Cargo environment already set:

```sh
FINANCE_SUITE=part25 scripts/run-gate.sh start --gate test:rust-finance
scripts/run-gate.sh wait --follow
```

Finance's privacy removal controls exercise `installed`, so they run for the full gate and
`FINANCE_SUITE=installed`, but not `FINANCE_SUITE=part25`. Meals retains its privacy controls
with its sole `installed` database suite.

Memory's existing comma-separated `MEMORY_SUITES` remains supported, including the
`test:rust-memory-recording` command. A non-empty `MEMORY_SUITE` takes precedence.

Meetings also retains `MEETINGS_ONLY` for running a suite against prebuilt components.
A non-empty `MEETINGS_SUITE` takes precedence and builds prerequisites even if
`MEETINGS_ONLY` is also set.

## Connectors on PRs

`CONNECTORS_SKIP_SYNC_SPEED=1` omits the long `sync_speed` host test from the prerequisite
checks inside `test:rust-connectors`. All other checks and database suites still run.
Leave it unset, empty, or `0` on main/nightly runs to retain the benchmark. Other values fail.
This is an explicit opt-out; the gate does not infer the CI event.

```sh
CONNECTORS_SKIP_SYNC_SPEED=1 scripts/run-gate.sh start --gate test:rust-connectors
scripts/run-gate.sh wait --follow
```

`CONNECTORS_TESTS` continues to select the database suites independently. These controls do
not add CI jobs or change which gates are required.

## Required CI tiers

Memory splits its five database files, with `index` and `oracle` in their own jobs.
News separates `installed` from `reader`.

The first real per-file PR run (#4420, run 44601271371) still exceeded 30 minutes in
Memory's `db` and News's `installed`. Under the plan's kill rule, those whole files now run
on main pushes. News's guard-removal controls are in `installed`. Memory also moves the
existing guard-removal test in each of `account`, `recording`, and `reembed` to the
main-push tier. PRs keep all other tests in those files, plus `dashboard`, `index`, `oracle`,
and News's `reader`. Every main push now runs the full module matrix, including those deferred files and all
guard-removal controls. Nightly runs the same full matrix plus all host gates.

`MEMORY_CONTROLS=skip` excludes exactly those three named tests; `only` selects the control
in the chosen file with an exact test-name filter. The names live in
`modules/memory/tools/control-selection.ts`. Unset or `all` retains the full local gate;
manual workflow runs also retain all files and controls. Unknown control modes fail before
building. No test assertions or fixture behavior change.
Each database entry still builds and checks its own module prerequisites.

Connectors uses `CONNECTORS_SUITE` to select one host test file in **both** the prerequisite
check and the ignored database phase. Its entries are `package`, `registry`, `mail_probe`,
`db`, `google_sync`, `google`, `imap`, `refresh`, `outlook`, and `writes`. This prevents each
entry from repeating every other file's non-ignored tests. Native/UI tests, parity oracles,
fixture checks, and the guest build remain prerequisites of every entry. The full local gate
is unchanged; `CONNECTORS_TESTS` still works when `CONNECTORS_SUITE` is unset or empty.
Unknown non-empty `CONNECTORS_SUITE` values fail before building. Selecting `sync_speed`
explicitly while also skipping it fails rather than silently testing nothing.
Manual workflow runs retain `sync_speed` as an additional entry; pull requests omit it.

The next real PR run (44615887769) measured Connectors `refresh` at 31.07 minutes, so its
whole file now runs on main pushes. Its guard-removal control moves with it. The eight
existing guard-removal tests in `db`, `google_sync`, `google`, `imap`, and `writes` also
move to the main tier. This includes the whole upgrade test, which contains a removal
control; its assertions are unchanged. PRs keep the other nine entries with
`CONNECTORS_CONTROLS=skip`. Main and nightly run the full files with `all`; `only` remains
available for local control checks. Unset or `all` retains full local/manual coverage. Exact test names live in
`modules/connectors/tools/control-selection.ts`. Unknown control modes fail before building.

`scripts/rust-gate-matrix.mjs` expands the touched-module list on PRs. A shared host change
runs the plan's thirteen host entries (including Calendar's `check.sh`) instead of fanning out
to all modules; mixed PRs also run directly touched modules. All Rust entries now block
`ci-gate`, which still accepts a skipped matrix when no Rust paths changed.
Notes includes its server and ingest companions; Calendar includes its server companion.
Companions run in separate jobs to preserve the measured package-job time budget.
The standalone Calendar workflow is replaced by the host tier.

The nightly schedule runs at 08:23 UTC on main. Workflow dispatch accepts a `rust_tier`
(`pull_request`, `push`, `schedule`) so the same routing can be verified on a PR ref.
`live_candidate` runs Scratchpad's live gate for account-free hosted verification; no live
gate joins the schedule until that proof passes. Other live gates remain unpromoted.
The runner-only `.github/ci-bin/devports` supplies isolated port claims to existing host tests;
local runs continue to use the machine's allocator.
Each job prints `GATE_RESULT` with its module and entry, then bounded Cargo compile and test
file timing summaries, including on cancellation. Setup time is included in the job wall time.
