# rust-spike (throwaway)

Phase 0a of the Rust port plan (`docs/superpowers/specs/2026-11-06-rust-port-plan.md`). This
folder proves four portability facts and nothing else. It is not the start of the Rust app:
delete it once the report is accepted. Findings live in
`docs/superpowers/specs/2026-11-07-rust-phase0a-report.md`.

Nothing here touches the TypeScript app, its tests, a real secret or any database.

## Layout

| Path                                      | What it is                                                           |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `fixtures-gen/generate.ts`                | Runs the app's own TypeScript code and records what it makes         |
| `fixtures/`                               | The recorded values: password hashes, envelopes, migration checksums |
| `portability/`                            | Facts 1 to 3: passwords, credential envelopes, migration checksums   |
| `fixtures-gen/check-rust-made.ts`         | Feeds values Rust made back through the app's code                   |
| `keystore/`                               | Fact 4: key unlock and recovery on Linux with no keychain            |
| `keystore/src/bin/keystore-ui.rs`         | The setup and recovery screens, served on 127.0.0.1                  |
| `keystore/src/bin/fake-secret-service.rs` | A stand-in keychain on a private session bus                         |
| `keystore/proof/drive.ts`                 | Drives the screens in Chromium and records each check                |
| `tools/plant-keystore-bugs.py`            | Plants one bug at a time and records which test catches it           |

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
