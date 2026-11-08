# Module host checkpoint

This is an isolated Rust library for Phase 4b. It is **not wired into the running Moss app**.
The phase is incomplete; see the report and its remaining-work list before building on it.

The sample is a real WebAssembly component in `sample/module.wat`. Tests turn it into wasm,
create a deterministic `.mosspkg`, sign its digest with ephemeral Ed25519 keys, publish a signed
registry folder and install it through `Installer`. The guest uses the host's account-scoped
key-value port. No private signing material or pretrusted production keys are included.

## Verify

Run from `~/Jarv1s`. Rust 1.95 is the toolchain used for this checkpoint. Keep Cargo output outside
the checkout so the repository's format checker does not scan generated fingerprints.

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml
CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 clippy --locked --manifest-path rust-spike/module-host/Cargo.toml --all-targets -- -D warnings
cargo +1.95.0 fmt --manifest-path rust-spike/module-host/Cargo.toml --check
CARGO_TARGET_DIR=/tmp/moss-module-host-target python3 rust-spike/module-host/tools/remove-protections.py
```

Database tests refuse to run without the verify-gate marker. The wrapper starts a fresh,
disposable PostgreSQL server, migrates it, runs the two real database tests serially, and removes
it afterwards. Never run the ignored tests against a normal development database.

```sh
CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate ./rust-spike/module-host/tools/gate.sh
scripts/run-gate.sh wait --follow
```

`tools/remove-protections.py` removes one named protection at a time in a disposable sibling
copy and requires its corresponding assertion to fail. It never changes the original source.
There are no runtime bypass settings.

## Boundaries and current limits

`runtime::Ports` is a trusted host-side service interface. The guest never implements it.
`LocalPorts` supplies account-scoped key-value data, module files and bounded HTTPS GET.
`DatabasePorts` adds typed queries on owned tables through the caller's `DataContext` and a
restricted module role. Other named WIT ports currently refuse calls until real services are
connected. They must not be described as implemented features.

`FileLifecycle` refuses database-owning or scheduled-job modules. `PostgresLifecycle` handles the
new owner-only SQL ledger; it also refuses scheduled-job and legacy-ledger modules. Production
startup, queue integration, credential services, sharing policies, recovery after a process
crash, and full schema restoration still need work. Do not install production packages with this
checkpoint.

The PostgreSQL adapters are synchronous and own Tokio runtimes. Production assembly needs a
bounded blocking executor; do not call these methods directly from an async request task.
