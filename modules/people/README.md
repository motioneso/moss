# People & Context

Phase 5 part one contains the pure People Rust core, canonical-note decisions and TypeScript
differential fixtures. It is not yet an installable package or a working Rust People screen.
The [delivery report](../../docs/superpowers/specs/2026-11-08-rust-phase5-people-report.md)
records the approved slice and exact continuation plan for part two.

The crate lives in `src/`, as required by section 7 of the module package spec. It uses only
pure dependencies. The shared SDK, database queries and frame are owned by the Tasks builder;
this module will consume those interfaces after their checkpoint reaches main.

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
