# People & Context

The Rust checkpoint contains the pure People core, canonical-note decisions, TypeScript
differential fixtures, an SDK-backed repository, canonical-note service and two job handlers. It is not yet an
installable package or a working Rust People screen.
The [delivery report](../../docs/superpowers/specs/2026-11-08-rust-phase5-people-report.md)
records each delivered slice and the exact remaining continuation work.

The crate lives in `src/`, as required by section 7 of the module package spec. Its repository
consumes the merged shared SDK's query and context ports. The host supplies the actor and
invocation transaction; the repository has no database connection or filesystem access.
Ben approved the optional pinned `wit-bindgen` dependency on 2026-11-08. Its generated
binding and the host wrapper build a `wasm32-wasip2` People component. The handwritten SDK
canonical ABI remains available for comparison. Both paths use the same People handlers,
including read APIs, data/note route envelopes, seven tool execution handlers and both job kinds. Older handwritten
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
an existing sysroot). This comparison build uses `wasm32-unknown-unknown`; use the separate
generated build below for `wasm32-wasip2`:

```sh
CARGO_TARGET_DIR=/tmp/moss-people-wasm MOSS_HOST_TARGET_DIR=/tmp/moss-module-host-target modules/people/tools/build-component.sh /tmp/moss-people-component.wasm
JS50_PEOPLE_COMPONENT=/tmp/moss-people-component.wasm CARGO_TARGET_DIR=/tmp/moss-module-host-target cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml --test people_guest -- --ignored --nocapture
```

The generated build uses the pinned Rust compiler and its `wasm32-wasip2` target. Keep any
dependency/target setup inside this worktree or scratch space. `MOSS_GUEST_CARGO_HOME` and
`MOSS_GUEST_RUSTUP_HOME` optionally select those existing guest caches independently of the
host builder's Cargo configuration:

```sh
CARGO_TARGET_DIR=/tmp/moss-people-wasip2 MOSS_HOST_TARGET_DIR=/tmp/moss-module-host-target modules/people/tools/build-generated-component.sh /tmp/moss-people-generated.wasm
```

The wrapper closes standard-library WASI functions with local traps. They confer no host
filesystem, network, clock or randomness service. Normal module work must use the declared
Moss ports. Calling a closed WASI function fails the invocation; the host's runtime import
rules remain unchanged. The note parser uses a tree map rather than randomized hashing.
This build is still an internal component, not an installed module or a complete Settings UI.

The database differential and failing-first privacy matrix use a disposable verify-gate
server, the unchanged seven legacy tables, and both production runtime roles:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-component.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate rust-spike/module-host/tools/people-gate.sh
scripts/run-gate.sh wait --follow
```

The TypeScript oracles check native mutation responses and persisted rows, compiled read
responses, seven tool execution functions, worker rows and canonical-note service responses and bytes
against the existing implementation. Set `JS50_PEOPLE_SUITE` to one of the suite names in
`people-gate.ts` to isolate a failure; leaving it unset runs the whole People gate.
Generated IDs and timestamps use the parity harness's normalization. This is not the full HTTP parity suite. Complete route/error/fallback compatibility, ingest scheduling, package installation and authenticated UI/chat/device checks remain
in the report's continuation plan. Preferences still belong to `app.preferences`.

The worker suite uses the real generated guest, queue, immutable command records and
worker-role transaction adapter. The actual TypeScript index worker is its differential
oracle; optional signal-provider delivery is a fixture. Source hashes and versions remain
in account records, while queue parameters carry only command UUIDs. See
[the job contract](PUBLIC_API.md#internal-job-dispatch-checkpoint) for retries, provider
composition, retention limits and publication after commit. No installed job scheduler or
live provider path is claimed by that suite.

The merged Notes foundation supplies `LinkedNotesPorts`; People does not implement file I/O.
Trusted composition maps the `people-notes` resource to `people-notes-folder` in
`app.preferences`, resolving legacy relative values against `notes-source-path`. The guest
uses its bounded list/read/compare-write contract, rechecks canonical IDs and projects aliases
and emails through the same invocation's database transaction. Call failure compensates file
writes only while the published bytes still match. External edits survive compensation;
process death is not recovered. The host adapter's remaining filesystem-race limitations
are documented in [the adapter contract](../notes/HOST_ADAPTER.md).

This checkpoint adds list/resolve/detail/links, match review, merge/split and
create/update/archive/refresh route envelopes. Rename/archive retain the projection fallback
when canonical notes are missing/unavailable; failures after publication still abort and
compensate. Internal errors return the fixed HTTP error body rather than host details.
It has no installed HTTP routing or UI. Folder settings, directory browsing, index-refresh
routes, ingest nudges and Fastify-compatible body validation remain continuation work.
Scans fail explicitly above two thousand entries or four MiB of text;
individual files retain the adapter's size bound. This bounded scan is not unlimited-folder
parity. No People screen or Settings choice is declared as available yet.

The additional route-envelope differential gate uses the real legacy Fastify handlers,
disposable PostgreSQL and the compiled guest with the shared route resolver. It compares
each reply and all seven table snapshots, including other-user and administrator attempts:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-generated.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate modules/people/tools/routes-gate.sh
scripts/run-gate.sh wait --follow
```

This covers the enumerated valid-body workflows and selected query/error cases. It does
not exercise an HTTP listener, installed package, browser, malformed-body compatibility,
chat approvals or a second device. Those remain required for full People acceptance.
