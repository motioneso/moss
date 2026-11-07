# rust-spike (throwaway)

Phases 0a and 1 of the Rust port plan (`docs/superpowers/specs/2026-11-06-rust-port-plan.md`).
Phase 0a proves four portability facts. Phase 1 (`bundled-db/`) proves that Rust can run a
private, bundled Postgres with pgvector for one install. This is not the start of the Rust app.
Delete it once the reports are accepted. Findings live in
`docs/superpowers/specs/2026-11-07-rust-phase0a-report.md` and
`docs/superpowers/specs/2026-11-07-rust-phase1-report.md`.

Nothing here touches the TypeScript app, its tests, a real secret or the dev or prod database.
Phase 1 makes its own throwaway databases in a scratch folder.

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
| `bundled-db/src/main.rs`                  | Phase 1: `moss-db`, which starts, migrates, checks and stops a database    |
| `bundled-db/src/at_rest.rs`               | Phase 1: reports whether disk encryption is verified on, off or unknown    |
| `bundled-db/pg-module/`                   | Phase 1: a Postgres add-on that stops crash dumps of the database on Linux |
| `bundled-db/proof/linux/`                 | Phase 1: builds the Linux bundle and runs the crash and leftover proofs    |
| `bundled-db/proof/mac/`                   | Phase 1: the same steps by hand on a Mac, plus the signing tests           |

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
