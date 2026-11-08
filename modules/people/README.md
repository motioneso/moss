# People & Context

The Rust checkpoint contains the People core, SDK-backed repository, canonical-note service,
two job handlers, route envelopes and a packaged Leptos Settings pane. The installed-package
gate adds registry installation and dispatch assertions. Installation/reload passed, but
the full replay and consumer checks remain unverified after the final folder-setting fix. The authenticated Rust application still
needs to compose that package into its real Settings and chat flows.
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
This command builds only the component. Build the Settings assets and package below before
qualifying installation; component tests alone do not prove an installed application.

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
Folder settings, relative directory browsing and legacy body-schema validation are included.
Index-refresh, ingest nudges and complete HTTP compatibility remain continuation work.
Scans fail explicitly above two thousand entries or four MiB of text;
individual files retain the adapter's size bound. This bounded scan is not unlimited-folder
parity. The manifest declares the packaged Settings screen; real shell reachability remains
unqualified.

The additional route-envelope differential gate uses the real legacy Fastify handlers,
disposable PostgreSQL and the compiled guest with the shared route resolver. It compares
each reply and all seven table snapshots, including other-user and administrator attempts:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-generated.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate modules/people/tools/routes-gate.sh
scripts/run-gate.sh wait --follow
```

This covers the enumerated workflows, malformed bodies, coercion and query/error cases.
Without `JS73_PEOPLE_PACKAGE` it exercises the compiled guest directly. Add that variable
with the package path to replay through signed registry installation, reload and installed
dispatch, and check the four public APIs through an installed consumer fixture. It does not
exercise an HTTP listener, browser, real chat approvals or a second physical device.

## Part five Settings checkpoint

`ui/` now contains the Leptos Settings pane, using the shared module kit and the
opaque-frame bridge. Its build uses the already declared Leptos/wasm-bindgen dependencies:

```sh
RUSTUP_HOME=/path/to/task-local/rustup CARGO_TARGET_DIR=/tmp/moss-people-ui modules/people/ui/build.sh /tmp/moss-people-ui-dist
cargo +1.95.0 test --locked --manifest-path modules/people/ui/Cargo.toml --no-default-features --features ssr
```

The parent bridge's authenticated `request` callback must return the decoded response body
directly and throw on failed requests. Unwrap the guest route's `{status, body}` envelope
before returning from that callback. The screen never fetches account data directly. Supply shared assets from
`rust-spike/module-ui/build-assets.py` at `/module-shared/` and attach the parent bridge
before assigning the verified iframe URL. The parent supplies `theme` and `colorMode` strings.

Trusted assembly connects `AccountPreferencesPorts` with these bindings (guests cannot
choose a key, account or allowed roots):

- `people` / `people-folder`: `Binding::Folder`, key `people-notes-folder`, trusted roots by account.
- `people` / `people-suggestions`: `Binding::BooleanOverride`, key `sourceBehaviors`,
  entry `people.notes.suggest-updates`, default `true`.

These settings write `app.preferences`, preserving the preference revision and unrelated
source-behavior overrides. Like the existing KV port, they commit independently of the
module invocation. A failed later guest call does not roll back an already saved preference.
Keep these settings routes single-operation calls. The linked-notes adapter still uses the
same `people-notes-folder` and `notes-source-path` binding documented above.

The manifest now declares the supplied screen, settings, recovery guidance and API versions.
The build utility assembles an unsigned package and checks the unchanged SQL inventory:

```sh
cargo +1.95.0 run --locked --manifest-path rust-spike/module-host/Cargo.toml --example pack_people -- /tmp/moss-people-generated.wasm /tmp/moss-people-ui-dist /tmp/people.mossmod
```

This build does not publish or install a registry package. The authenticated shell still
needs to compose the installer/frame, these host adapters and provider dependencies. A build,
render test or standalone screen preview is not proof of installed Settings, chat or a
second physical device. See the report for the remaining acceptance work.

## Part six installed-dispatch checkpoint

Build the component, UI and unsigned package using the commands above, then run:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-generated.wasm JS73_PEOPLE_PACKAGE=/tmp/people.mossmod CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate modules/people/tools/routes-gate.sh
scripts/run-gate.sh wait --follow
```

The gate pins both artifacts, signs a temporary registry, downloads and installs the actual
People package with `PostgresLifecycle` and its unchanged legacy SQL, then reopens the
installer. A separate installed consumer fixture is set up to call all four public lookup APIs;
that portion has not completed successfully. The provider
package and unavailable AI service are explicit fixtures; no real source delivery is claimed.
The gate contains Settings HTML asset assertions, not a rendered or authenticated installed
screen check. The final package replay still needs a green run.

The legacy `/people/notes-directories` endpoint browses relative to the selected folder;
the additive `/people/note-folders` endpoint remains the absolute-root chooser. Empty and null folder
saves retain the legacy 400 folder error and preserve the existing preference. Body validation retains Fastify's coercion and safe
400 error text for the cases in the oracle. Repeated equality filters use node-postgres
array text; repeated search values use JavaScript array joining. Positive limits above the
SDK's `u32` page space scan without a limit if they fit PostgreSQL `int8`.

Remaining acceptance: compose the real installed shell and chat; index-refresh/cooldown,
ingest nudges, real source providers and command retention/quotas; broaden HTTP parity
(including locale-sensitive directory ordering and unusual note-only values); and run the
real UI on desktop and a second physical device over HTTPS with sign-in, origin and privacy
checks. This is a checkpoint, not full People acceptance. Exact receipts are in the report.
