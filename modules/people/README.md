# People & Context

The Rust checkpoint contains the pure People core, canonical-note decisions, TypeScript
differential fixtures and a partial SDK-backed native repository. It is not yet an
installable package or a working Rust People screen.
The [delivery report](../../docs/superpowers/specs/2026-11-08-rust-phase5-people-report.md)
records the approved slice and exact continuation plan for part two.

The crate lives in `src/`, as required by section 7 of the module package spec. Its repository
consumes the merged shared SDK's query and context ports. The host supplies the actor and
invocation transaction; the repository has no database connection or filesystem access.
No component binding generator has been added. The handwritten SDK canonical ABI and host
wrapper now run a compiled Rust People guest, with its completed read APIs. Older handwritten
fixtures still exercise a native test driver; those are separate persistence evidence.

From `~/Jarv1s`:

```sh
CARGO_TARGET_DIR=/tmp/moss-people-target cargo +1.95.0 test --locked --manifest-path modules/people/src/Cargo.toml
CARGO_TARGET_DIR=/tmp/moss-people-target cargo +1.95.0 clippy --locked --manifest-path modules/people/src/Cargo.toml --all-targets -- -D warnings
cargo +1.95.0 fmt --manifest-path modules/people/src/Cargo.toml --check
pnpm exec tsx modules/people/tools/core-vectors.ts > /tmp/moss-people-core-parity.json
cmp modules/people/src/tests/fixtures/core-parity.json /tmp/moss-people-core-parity.json
```

The vector generator runs the current TypeScript matching and note-format implementation.
It performs no database work. These fixtures prove only pure domain behavior. Database
and live checks must go through verify-gate and the real Rust application before full People
parity can be accepted.

Build the current handwritten component with an already available `wasm32-unknown-unknown`
standard library compatible with the pinned compiler (the optional `MOSS_WASM_SYSROOT` selects
an existing sysroot). This is not the required `wasm32-wasip2` shipping build, and does not
authorize installing a target or generator:

```sh
CARGO_TARGET_DIR=/tmp/moss-people-wasm MOSS_HOST_TARGET_DIR=/tmp/moss-module-host-target modules/people/tools/build-component.sh /tmp/moss-people-component.wasm
JS50_PEOPLE_COMPONENT=/tmp/moss-people-component.wasm CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml --test people_guest -- --ignored --nocapture
```

The database differential and failing-first privacy matrix use a disposable verify-gate
server, the unchanged seven legacy tables, and both production runtime roles:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-component.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate rust-spike/module-host/tools/people-gate.sh
scripts/run-gate.sh wait --follow
```

The TypeScript oracle checks native responses and persisted projection rows with the parity
harness's normalization. This is not the full HTTP parity suite. Full mutation services,
linked-notes integration, package installation and authenticated UI/chat/device checks remain
in the report's continuation plan. Preferences still belong to `app.preferences`.
