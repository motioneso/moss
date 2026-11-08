# rust-spike (throwaway)

Phases 0, 1 and 2 of the Rust port plan (`docs/superpowers/specs/2026-11-06-rust-port-plan.md`).
It is not the start of the Rust app. Delete it once the reports are accepted.

- Phase 0a proves four portability facts. Findings are in
  `docs/superpowers/specs/2026-11-07-rust-phase0a-report.md`.
- Phase 0b rebuilds Tasks in Rust and checks it against the TypeScript server side by side.
  Findings are in `docs/superpowers/specs/2026-11-07-rust-phase0b-report.md`.
- Phase 1 (`bundled-db/`) proves that Rust can run a private, bundled Postgres with pgvector for
  one install. Findings are in `docs/superpowers/specs/2026-11-07-rust-phase1-report.md`.
- Phase 2a builds the safety core every module shares and runs Tasks on it. Findings are in
  `docs/superpowers/specs/2026-11-07-rust-phase2a-report.md`.
- Phase 2b (`platform/`) builds the job queue, module registry and capability routing in its
  own Cargo workspace, with its own readme. Findings are in
  `docs/superpowers/specs/2026-11-07-rust-phase2b-report.md`.
- Phase 3 (`agents/`) drives Claude, Codex and OpenCode from Rust, confines each account's agent
  and links the chat drawer to it. It is its own Cargo workspace. Findings are in
  `docs/superpowers/specs/2026-11-08-rust-phase3-report.md`.

Nothing here changes the TypeScript app or its tests. Phases 0b and 2a use only throwaway databases
made by `scripts/run-gate.sh`, never the dev or prod database. Phase 1 makes its own throwaway
databases in a scratch folder and never touches the dev or prod database.

## Layout

| Path                                      | What it is                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `fixtures-gen/generate.ts`                | Runs the app's own TypeScript code and records what it makes               |
| `fixtures/`                               | The recorded values: password hashes, envelopes, migration checksums       |
| `portability/`                            | Facts 1 to 3: passwords, credential envelopes, migration checksums         |
| `fixtures-gen/check-rust-made.ts`         | Feeds values Rust made back through the app's code                         |
| `keystore/`                               | Fact 4: key unlock and recovery on Linux with no keychain                  |
| `keystore/src/bin/keystore-ui.rs`         | The setup and recovery screens, served on 127.0.0.1                        |
| `keystore/src/bin/fake-secret-service.rs` | A stand-in keychain on a private session bus                               |
| `keystore/proof/drive.ts`                 | Drives the screens in Chromium and records each check                      |
| `tools/plant-keystore-bugs.py`            | Plants one bug at a time and records which test catches it                 |
| `tasks/`                                  | Phase 0b: the Tasks server in Rust                                         |
| `parity/`                                 | Phase 0b: runs both servers side by side and compares them                 |
| `parity/cases/`                           | The side-by-side cases, as JSON                                            |
| `parity/conversion-ledger.md`             | Every Tasks test, how it was converted, and the counts                     |
| `ui/`                                     | Phase 0b: the Tasks screen in Leptos and in Dioxus                         |
| `tools/plant-parity-bugs.sh`              | Phase 0b: plants three bugs in the Rust server and checks each fails       |
| `tools/check-role-guard.sh`               | Phase 0b: checks the server refuses roles that escape row security         |
| `tools/count-code.sh`                     | Phase 0b: counts the code and tests the report scales from                 |
| `bundled-db/src/main.rs`                  | Phase 1: `moss-db`, which starts, migrates, checks and stops a database    |
| `bundled-db/src/at_rest.rs`               | Phase 1: reports whether disk encryption is verified on, off or unknown    |
| `bundled-db/pg-module/`                   | Phase 1: a Postgres add-on that stops crash dumps of the database on Linux |
| `bundled-db/proof/linux/`                 | Phase 1: builds the Linux bundle and runs the crash and leftover proofs    |
| `bundled-db/proof/mac/`                   | Phase 1: the same steps by hand on a Mac, plus the signing tests           |
| `access-context/`                         | Phase 2a: who is acting, shared by the safety core and the vault           |
| `safety-core/`                            | Phase 2a: sign-in, admin routes, data context, secrets, redaction          |
| `vault/`                                  | Phase 2a: file access that cannot leave its folder                         |
| `parity/cases/20-safety-*.json`           | Phase 2a: the safety cases, run against both servers                       |
| `tools/check-safety-rules.sh`             | Phase 2a: fails on file access, secret use or prints out of place          |
| `tools/remove-protections.sh`             | Phase 2a: removes each protection in a copy and checks a test fails        |
| `agents/src/runner.rs`                    | Phase 3: one confined agent per account, clean launch environment          |
| `agents/src/bin/moss-runner.rs`           | Phase 3: the runner process and its owner-only socket                      |
| `agents/parity/`                          | Phase 3: permission and approval rules checked against the TypeScript      |
| `agents/proof/containment.sh`             | Phase 3: what a confined agent can reach, with an unconfined control       |

## Running

Needs the Rust toolchain in `~/.cargo/bin`, `dbus-daemon` for the key store tests, and the
repo's own `pnpm install`. Run the TypeScript scripts from the repo root and cargo from this
folder. The cargo target folder below is `rust-spike/target` unless `CARGO_TARGET_DIR` says
otherwise.

Regenerate the fixtures (only when the app's code changes):

```
pnpm exec tsx rust-spike/fixtures-gen/generate.ts
```

Facts 1 to 3, then the app's check of what Rust made:

```
cargo test -p portability --no-fail-fast -- --nocapture
```

```
pnpm exec tsx rust-spike/fixtures-gen/check-rust-made.ts <cargo target folder>/tmp/rust-made.json
```

Fact 4:

```
cargo test -p keystore --no-fail-fast
```

```
cargo build -p keystore --bins
```

```
pnpm exec tsx rust-spike/keystore/proof/drive.ts <port> <scratch folder> <cargo target folder>/debug/keystore-ui <cargo target folder>/debug/fake-secret-service
```

The browser proof takes a free port from `devports claim <name>` and writes its screenshots and
log under the scratch folder. The planted-bug run edits the source in place and restores it, so
start it from a clean tree:

```
python3 -I tools/plant-keystore-bugs.py . <output file>
```

## Running Phase 0b

The side-by-side run needs a migrated throwaway database, so it only runs inside a gate run. From
the repo root:

```
scripts/run-gate.sh start --gate rust-spike/parity/run-parity.sh
```

```
scripts/run-gate.sh wait --follow
```

The run builds both Rust crates, builds the app map the TypeScript server reads at startup, claims
two ports with `devports`, and prints PASS or FAIL per case and a final PARITY line. Exit 0 means
every case matched. Extra arguments pass through to the runner, for example `--only "lists"`.
Output goes to `<cargo target folder>/parity` unless `PARITY_OUT` says otherwise.
`PARITY_COPY_PREFIX` names the two database copies, so two runs can share one throwaway server.

The Rust Tasks unit tests, from this folder:

```
cargo test -p tasks
```

Two more checks run the same way, each as its own gate run. One plants three bugs in copies of
the Rust server and exits 0 only if the side-by-side run catches every one. The other starts the
server on unsafe database roles and exits 0 only if it refuses each one.

```
scripts/run-gate.sh start --gate rust-spike/tools/plant-parity-bugs.sh
```

```
scripts/run-gate.sh start --gate rust-spike/tools/check-role-guard.sh
```

The code counts need no database, so they run anywhere in the repo.

```
rust-spike/tools/count-code.sh
```

`ui/README.md` says how to build and run the two screens.

## Running Phase 1

The Linux scripts need a scratch folder for the Postgres build, the installs and the logs. Set
`MOSS_SPIKE_SCRATCH` to it and save the two source archives named in `build-pg.sh` under its
`downloads/` folder. Run the scripts from the repo root and cargo from this folder, as above:

```
bash rust-spike/bundled-db/proof/linux/build-pg.sh
```

```
cargo test -p bundled-db
```

```
cargo build -p bundled-db
```

Each `moss-db` command prints JSON. `up` stays in the foreground and prints one event per line:

```
moss-db up --root <install folder> --pg <scratch>/pg/17.11-linux-x86_64 --repo <repo root>
```

```
moss-db check --root <install folder>
```

```
moss-db at-rest --root <install folder>
```

```
moss-db stop --root <install folder>
```

`proof/linux/proof-nodump.sh STEP` runs one recorded proof against the installs under
`<scratch>/runs`. Its first lines list the steps. The crash steps read Ubuntu's crash-handler
log, so they expect Ubuntu.

The Mac scripts run on the Mac itself, from a copy of `proof/mac/`, and keep everything in
`~/moss-js37`. In order: `build.sh`, `bundle.sh`, `flows.sh init`, `flows.sh lifecycle`, then
the other `flows.sh` steps, `sign.sh adhoc` and `app-layout.sh`. `sign.sh identity` needs the
login keychain unlocked, so run it in Terminal on the Mac, not over SSH.

## Running Phase 2a

The safety cases in `parity/cases/20-safety-1.json` and `20-safety-2.json` run as part of the
side-by-side run above. Both servers run in test mode there, which turns off the sign-in origin
check, so that check is covered by unit tests instead.

The safety-core, vault and access-context unit tests need no database. From this folder:

```
cargo test -p safety-core -p vault -p access-context
```

The rules check needs no database either. It exits 1 and prints the lines if any rule breaks.

```
tools/check-safety-rules.sh .
```

The protection-removal run needs a gate run, because 11 of its 18 removals start servers on a
database. It exits 0 only if every removal makes a test fail. Each removal's diff and output go
to `target/protections` unless `PROTECTIONS_OUT` says otherwise.

```
scripts/run-gate.sh start --gate rust-spike/tools/remove-protections.sh
```

Outside test mode the server refuses a sign-in posted from a page it does not trust. It trusts its
own address on this machine. To sign in from a phone or another computer, list that page's address
in `JARVIS_AUTH_TRUSTED_ORIGINS`, separated by commas.
