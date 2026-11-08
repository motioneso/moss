# Tasks data foundation

This is an unfinished module package, not an installable Tasks replacement.
`src/` contains native data primitives using only the pure module SDK, serde and
chrono. `tools/` is a separate host-side verification crate and is never linked
into the guest. The original SQL remains in `packages/tasks/sql/`; metadata tests
check all nine files against the host's frozen inventory.

From the repository root:

```sh
cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/src/Cargo.toml
cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --test metadata
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-domain-check
JS51_DOMAIN_BIN=modules/tasks/tools/target/debug/tasks-domain-check pnpm exec tsx modules/tasks/tools/recurrence-parity.ts
```

Database tests **must** use the repository's verify-gate workflow:

```sh
scripts/run-gate.sh start --gate modules/tasks/tools/gate.sh
scripts/run-gate.sh wait --follow
```

The gate uses real existing tables and real host-owned invocation transactions.
A sample Wasm trampoline obtains that invocation context, then calls native
Tasks logic through a test-only port. This proves neither a Tasks component ABI
nor installed-package dispatch. The privacy control runs identical cross-account
read/write assertions with RLS removed, requires them to fail, restores RLS, and
requires them to pass. It alters only the gate's disposable database.

The recurrence comparison covers ordinary calendar dates and invalid inputs;
extended years, JavaScript Date overflow and huge intervals are not parity claims.
Full endpoint parity remains with `rust-spike/parity/` and has not been run against
this data-only crate. Routes, tools, jobs, recurrence orchestration, People public
API calls, component packaging and screens still need to be ported. See the Phase 5
Tasks report for the pending binding-generator decision and continuation plan.
