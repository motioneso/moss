# Tasks component checkpoint

This is an unfinished Tasks module package. Rust code now compiles into a real
component and handles basic task, list, tag, activity and view preference routes.
It also handles four read tools: `tasks.get`, `tasks.listLists`, `tasks.listTags`
and `tasks.activity`, with request schemas enforced inside the guest. It is not a
complete replacement for Tasks. Screens, nineteen other chat tools, background
jobs, People calls and full endpoint parity remain unfinished.

`src/` uses the guest-safe SDK. `wit/` defines its ABI. Ben approved the pinned
`wit-bindgen` generator on 2026-11-08, superseding the earlier decline. `tools/`
is a separate host-side verification crate, never linked into the guest.
The small `bindings/` crate uses the same approved generator graph's
`wit-component` encoder to wrap the core Wasm. Building directly for WASI imports services the host deliberately
refuses; the shipped build therefore targets `wasm32-unknown-unknown` and has no
WASI adapter. No global tool or compiler target installation is required by
these scripts: use an already provisioned Rust 1.95 toolchain with that target.
Restore the locked Cargo dependencies into a worktree or scratch Cargo home first.

From the repository root (set `CARGO_HOME`, `RUSTUP_HOME` and `CARGO_TARGET_DIR`
to your task's scratch directories if needed):

```sh
cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/src/Cargo.toml
modules/tasks/tools/build-component.sh /tmp/tasks-component.wasm
TASKS_COMPONENT=/tmp/tasks-component.wasm cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --test component --test metadata
cargo +1.95.0 run --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-pack -- /tmp/tasks-component.wasm /tmp/tasks.mosspkg
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-domain-check
JS51_DOMAIN_BIN=modules/tasks/tools/target/debug/tasks-domain-check pnpm exec tsx modules/tasks/tools/recurrence-parity.ts
```

When using `CARGO_TARGET_DIR`, point `JS51_DOMAIN_BIN` at that directory's
`debug/tasks-domain-check` instead. The archive is reproducible and unsigned;
registry trust, signing, installation and publication are separate checks.
All nine SQL files come from the original `packages/tasks/sql/` and are checked
against the host's frozen migration hashes. No migration bytes or ledger change.

Database tests **must** use the repository's verify-gate workflow:

```sh
scripts/run-gate.sh start --gate modules/tasks/tools/gate.sh
scripts/run-gate.sh wait --follow
```

The gate builds and validates the actual component before running the privacy
checks. The new component test dispatches declared route envelopes through real
Wasmtime, typed host calls and disposable PostgreSQL transactions. It removes
Tasks RLS and requires the exact cross-account read/write assertions to fail,
then restores RLS and requires them to pass. It also checks recurring completion
and repeated completion, and checks the four compiled read tools as the owner,
another account and an admin. The tool privacy assertion must fail when Tasks
RLS is removed and pass after restoration. Earlier native data checks retain their explicitly
labeled sample trampoline; those are not component-execution evidence.

The full existing endpoint differential harness can now target the actual
component through a disposable, authenticated loopback HTTP adapter:

```sh
TASKS_PARITY_OUT=/tmp/tasks-parity scripts/run-gate.sh start --gate modules/tasks/tools/parity-gate.sh
scripts/run-gate.sh wait --follow
```

The script builds both servers, claims and releases ports, and writes
`report.json` plus server logs to the output folder. It reuses the existing
cases and TypeScript server unchanged. Expected failures from unported routes,
tools and jobs are reported as failures; this script is not an installed package
or live UI proof. The unchanged harness does not yet compare the four new tools.

No live Tasks page exists yet. The recurrence differential check covers ordinary
calendar dates and invalid inputs, not full endpoint parity. Date parsing covers
the ISO branch; offset-free timestamps currently use UTC because the host has no
actor-timezone port. Lazy recurrence roll-forward needs that public host seam
before it can preserve the actor's local day. Additional routes, queued work
and public People calls also remain to be ported. See the
Phase 5 Tasks report for the exact validation results and continuation boundary.
