# People & Context

The Rust checkpoint contains the People core, SDK-backed repository, canonical-note service,
two job handlers, route envelopes and a packaged Leptos Settings pane. The installed-package
gate exercises signed registry installation, reload, route replay and all four public lookup
APIs through an installed consumer fixture; the report records the current result. The authenticated Rust
application still needs to compose that package into its real Settings and chat flows.
The normal People gate compares complete 100-person and 100-link lists from a
1,005-person account against the real legacy handlers, under the unchanged default host budgets.
The optional 29-case large-account diagnostic also covers links and larger limits, with intermediate 150, 175 and 190-row probes.
People requests 200M fuel in its manifest (60M fails the 1,005-contact paging cases, 200M passes
all 29), so large-account parity holds under that request.
Response conversion reuses database field-name buffers and moves formatted confidence
and timestamp strings into JSON values; this does not establish a larger supported limit.
With the task-owned build environment and generated component prepared as below, reproduce
through verify-gate:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-component.wasm scripts/run-gate.sh start --gate modules/people/tools/large-data-gate.sh
```

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

For all builds and gates, set `CARGO_HOME`, `RUSTUP_HOME` and `CARGO_TARGET_DIR` to
task-owned scratch directories with the pinned toolchain and declared dependencies available.
The target paths below are examples; choose paths owned by the current task. Shared caches
have disappeared during previous runs.

```sh
CARGO_TARGET_DIR=/tmp/moss-people-target cargo +1.95.0 test --locked --manifest-path modules/people/src/Cargo.toml
CARGO_TARGET_DIR=/tmp/moss-people-target cargo +1.95.0 clippy --locked --manifest-path modules/people/src/Cargo.toml --all-targets -- -D warnings
cargo +1.95.0 fmt --manifest-path modules/people/src/Cargo.toml --check
pnpm exec tsx modules/people/tools/core-vectors.ts > /tmp/moss-people-core-parity.json
cmp modules/people/src/tests/fixtures/core-parity.json /tmp/moss-people-core-parity.json
node modules/people/tools/directory-vectors.mjs > /tmp/moss-people-directory-parity.json
cmp modules/people/src/tests/fixtures/directory-parity.json /tmp/moss-people-directory-parity.json
node modules/people/tools/number-vectors.mjs > /tmp/moss-people-number-parity.json
cmp modules/people/src/tests/fixtures/number-parity.json /tmp/moss-people-number-parity.json
pnpm exec tsx modules/people/tools/note-scan-vectors.ts > /tmp/moss-people-note-scan-parity.json
cmp modules/people/src/tests/fixtures/note-scan-parity.json /tmp/moss-people-note-scan-parity.json
```

The vector generator runs the current TypeScript matching and note-format implementation.
The directory oracle records JavaScript `localeCompare` for canonical Unicode equivalents
and nearby case/order comparisons. The relative folder browser normalizes comparison keys
to NFC, preserving original names and paths and stable input order for equal keys.
Comparison decomposes letters canonically and keeps each accent in order, so
multiply accented names are compared before case, rather than losing accents or
using their composed code points. The oracle includes pairwise accent and case
comparisons for selected letter families; this remains a bounded collation implementation.
Index batches use one host-owned timestamp for their fifteen-minute delay, anchored at
batch start. Each item still gets its own command record and queue send; retries retain the
original record's delay. An empty batch performs no clock or queue work.

The note-scan oracle uses the real legacy vault walker on temporary synthetic folders,
including interleaved root files, sibling/nested folders, Unicode names, ignored extensions
and a deeply nested note. The guest preserves that depth-first listing order with an
explicit stack. Native checks retain the total-entry/text limits and stop before projection
on nested backend failures or disappearing files. This does not qualify every filesystem's
directory enumeration order. Directory comparison is canonical-equivalence coverage, not
complete locale collation. The existing
literal-dollar safeguard for managed-note edits remains unchanged.
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
Manual index refresh is included; ingest nudges and complete HTTP compatibility remain continuation work.
Scans fail explicitly above two thousand entries or four MiB of text;
individual files retain the adapter's size bound. This bounded scan is not unlimited-folder
parity. The shared adapter also refuses relative note paths over 1024 UTF-8 bytes and
non-UTF-8 filenames. Its byte-sorted immediate listings are the guest's traversal input;
the oracle records that host ordering separately from the real legacy walk.
The manifest declares the packaged Settings screen; real shell reachability remains
unqualified.

The additional route-envelope differential gate uses the real legacy Fastify handlers,
disposable PostgreSQL and the compiled guest with the shared route resolver. It compares
each reply and all seven table snapshots, including other-user and administrator attempts:

```sh
JS50_PEOPLE_COMPONENT=/tmp/moss-people-generated.wasm CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/moss-module-host-target scripts/run-gate.sh start --gate modules/people/tools/routes-gate.sh
scripts/run-gate.sh wait --follow
```

This covers the enumerated workflows, malformed bodies, coercion and query/error cases.
Other-user/admin note-edit attempts compare unchanged bytes, but those actors have no
configured folder. They do not prove shared-folder filesystem authorization.
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
installer. In part seven, the full enumerated replay and all four public lookup APIs passed
through an installed consumer fixture, with a positive owner lookup before unrelated-user
and administrator denial checks. The provider package and unavailable AI service remain
explicit fixtures; no real source delivery is claimed. Settings HTML, bootstrap, JavaScript,
Wasm and bridge assets are retrieved through the installer. This is not a rendered or
authenticated installed screen check.

The legacy `/people/notes-directories` endpoint browses relative to the selected folder;
the additive `/people/note-folders` endpoint remains the absolute-root chooser. Empty and null folder
saves retain the legacy 400 folder error and preserve the existing preference. Body validation retains Fastify's coercion and safe
400 error text for the cases in the oracle. Repeated equality filters use node-postgres
array text; repeated search values use JavaScript array joining. Positive limits above the
SDK's `u32` page space scan without a limit if they fit PostgreSQL `int8`.

On methods that parse a body, decoded JSON with `__proto__` members or `constructor` objects containing a
`prototype` member receive the legacy JSON-parser 400 before schema coercion or host
calls, including inside arrays and unknown note-only fields. Similar ordinary field names
and string values remain allowed. GET ignores supplied bodies, as in the legacy server.
Raw HTTP parser qualification still belongs to the
shipping listener; this check is at the module dispatch boundary.

Remaining acceptance: compose the real installed shell and chat;
ingest nudges, real source providers and command retention/quotas; broaden HTTP parity
(including locale-sensitive directory ordering and unusual note-only values); and run the
real UI on desktop and a second physical device over HTTPS with sign-in, origin and privacy
checks. This is a checkpoint, not full People acceptance. Exact receipts are in the report.

## Part seven canonical-edit checkpoint

The configured-folder replay compares real legacy Fastify responses, all seven table
snapshots and canonical note bytes against installed Rust dispatch. It covers rename,
archive/reactivation, ignored summaries, contact-list clearing, mixed JSON entries and
malformed edits. Note-backed PATCH preserves the legacy untyped contact-list behavior;
the typed note-service API and public lookup contracts are unchanged. The baseline guest
fails this replay; the corrected generated package passes. Broader inputs and live
application/device acceptance remain open as listed above.

## Part nine worker and refresh checkpoint

The shipping manifest now permits the indexing worker to read its optional provider map.
The regression runs the compiled guest with that actual manifest, command records and queue;
it requires a missing provider to finish without changing People rows. The existing broader
provider fixture still covers indexing signals and publication after commit. Real installed
provider delivery and scheduler retries remain open.

The configured-folder route oracle also covers successful creation, search/resolve of the
created person, nested refresh with duplicate IDs, missing IDs and ordinary markdown, a new
canonical record, two refreshes, review candidates and additional relative-directory cases.
All seeded and newly created note bytes are compared. Only generated frontmatter UUIDs and
correctly derived candidate hashes use ID normalization; user text and wrong hashes remain
literal. These are dispatch comparisons, not browser or physical-device evidence.

## Part ten manual indexing checkpoint

`POST /people/index/refresh` accepts the legacy source-reference batch and returns status
202 with its submitted count. It validates the entire batch, applies Fastify string coercion
and refuses more than fifty references before publishing any jobs. Each accepted reference
uses a fresh command UUID and the existing fifteen-minute index delay. Account selection
comes from the host; request fields cannot choose one. Opaque hashes and versions stay in
the account's command records rather than the queue payload.

The legacy People queue has the standard pg-boss policy, so repeated references and requests
remain separate jobs. Retrying an internal command by UUID still deduplicates. A queue
failure can leave earlier batch entries queued; the response is the safe legacy 500 error.
The route oracle now uses a real disposable pg-boss queue for manual refresh and compares
its source metadata with the real Rust queue and command records. This remains package
dispatch evidence; real application, source-provider and device acceptance are still open.

The installed route replay now uses the standard five-second host call budget, including
its fifty-reference request. Delayed sends reuse one producer connection within a
host-created invocation, whose actor and manifest are fixed. Every send still has its
own transaction and delay/key. Immutable command creation avoids a separate pre-read;
retries keep the original stored delay and reject conflicting commands. Each later
invocation connects afresh, including after
an idle disconnect. A failed send discards its handle without an automatic retry.
Immediate jobs and schedules
keep their existing path. The standard People gate includes real database checks for
connection reuse, schema replacement, disconnect recovery and account/queue key isolation.
See the part-sixteen report for the measured outcome and its limits.

A failed send can leave its command stored without a queued job; new manual requests
use fresh IDs and can duplicate earlier work and grow command storage. Retention,
quotas and shipping listener composition remain acceptance work.

## Part eleven folder-order checkpoint

Directory browsing now follows the tested legacy base-letter, accent and case
ordering instead of raw byte order. Complete locale-sensitive collation remains
unqualified. The route oracle
covers folder names whose order differs between the two schemes, and the
full installed replay and nine-suite gate pass on the recorded commit. The
authenticated shell still has no installed module composition, so live UI,
chat and second-device acceptance remain open. Exact receipts are in the
report.

## Part twelve numeric contact compatibility

Numeric values accepted by the legacy contact schemas keep JavaScript's shortest decimal
spelling when converted to text, including equal-distance rounding ties. Both projection-only
name edits and note-backed name/email/phone edits use the same conversion. Native regressions
cover those ties and notation boundaries; the installed route replay compares replies, all
seven tables and canonical note bytes against the real legacy handlers. See the part-twelve
report for the current receipts and the remaining application/device checks.

## Part thirteen JSON number parsing

The component enables correctly rounded binary64 parsing in its existing JSON dependency.
This prevents a numeric contact input from changing before the legacy text conversion runs.
The deterministic JavaScript oracle covers 283 literals, including underflow, subnormals,
rounding boundaries and seeded finite values. The route replay includes projection-only and
note-backed edits with a parser-sensitive input, comparing both replies and stored note bytes.
Part thirteen qualified the component parser, not an unassembled server's request parser or
real UI. Its replay host enabled the same JSON feature through its native People
dev-dependency (Cargo feature unification), masking a missing normal-host declaration.
Part fourteen explicitly enables the feature in the host and adds the independent regression
below. `dispatch_extended` parses the raw body before calling the component; a component
cannot recover a number already rounded incorrectly by its caller. The feature applies to
all JSON numbers parsed by these crates, including provider confidence values, not only
contact text. Listener and installed application qualification remain open.
The remaining application, provider, ingest, retention and device work listed above stays open.

## Part fourteen normal-host JSON regression

The route gate also runs a separate downstream executable before the People replay:

```sh
cargo +1.95.0 run --locked --offline --manifest-path modules/people/tools/host-json/Cargo.toml
```

Use the task-owned Cargo, Rustup and target directories described above. This executable
depends on the normal module host, without its native People dev-dependency and without
requesting JSON parser features itself. It installs a signed echo fixture and sends all
283 JavaScript numeric literals as raw request bodies through `Installer::dispatch_extended`,
comparing the numeric bits received across the component ABI. It also refuses three malformed or out-of-range
bodies. The echo isolates host parsing; it is not the People package, an HTTP listener,
an authenticated browser session or a second-device check. The existing installed People
replay separately compares contact edits, note bytes and all seven tables.
