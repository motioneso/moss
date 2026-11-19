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

## Per-file shadow CI entries

Memory now runs `db`, `dashboard`, `recording`, `reembed`, and `account` as separate entries,
with `index` and `oracle` in their own jobs. News separates `installed` from `reader`.
Each database entry still builds and checks its own module prerequisites.

Connectors uses `CONNECTORS_SUITE` to select one host test file in **both** the prerequisite
check and the ignored database phase. Its entries are `package`, `registry`, `mail_probe`,
`db`, `google_sync`, `google`, `imap`, `refresh`, `outlook`, and `writes`. This prevents each
entry from repeating every other file's non-ignored tests. Native/UI tests, parity oracles,
fixture checks, and the guest build remain prerequisites of every entry. The full local gate
is unchanged; `CONNECTORS_TESTS` still works when `CONNECTORS_SUITE` is unset or empty.
Unknown non-empty `CONNECTORS_SUITE` values fail before building. Selecting `sync_speed`
explicitly while also skipping it fails rather than silently testing nothing.

`scripts/rust-gate-matrix.mjs` expands the existing touched-module list. Unrelated modules keep
their existing commands. The jobs remain optional shadow jobs outside `ci-gate`'s `needs`.
Each job prints `GATE_RESULT` with its module and entry, then bounded Cargo compile and test
file timing summaries, including on cancellation. Setup time is included in the job wall time.
