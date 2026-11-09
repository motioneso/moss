# Calendar Rust package: cached-event screens and two chat tools

Part of #4027. This is the package and data foundation, **not the full Calendar port**.
The existing TypeScript app stays in place. Version 0.5.0 connects event links at
`/calendar?event=<id>` through the signed-in Calendar composition, restores duration,
attendee and status details, refreshes open details and closes a removed event.
Version 0.8.0 combines part 7 with the merged part 8 date and Day legend changes. It uses the account's assistant name in Calendar labels, held-event
wording and settings. Narrow Week screens explain sideways scrolling and bring today
into view when opening, navigating or resizing; routine refreshes keep the user's
horizontal position. Day, Week and Month screens, saved views and editable briefing settings are packaged.
Full shell composition, the source-behavior switch, the remaining four chat tools, jobs,
provider execution and the assembled HTTP/UI parity gate remain open.

Version 0.2.0 adds `calendar.heartbeatWindow` (owned cache reads) and
`calendar.dayPlanDraft` (typed evening intent and untimed task proposals). The latter
retains recorded placement and requires an actor-scoped public Tasks projection for
new task references. Neither tool calls a provider. The package advertises only these
two tools; it does not yet wire them into the authenticated chat gateway.

The guest in `src/` depends only on the SDK and pure Rust libraries. Its declared routes
and five public methods expose cached events, day-plan draft reads/create/save, and legacy
briefing-settings reads and writes. These are the data layer; the later UI adapter must retain the
existing HTTP request envelopes, default timezone and contextual response projections.

`moss.module.json` declares all five existing Calendar tables, their privacy classification,
and the fifteen original SQL identities. Packaging reads `packages/calendar/sql/` and checks
its bytes against the compiled inventory. It never copies new SQL over the TypeScript source.
Events retain owner-or-explicit-share rules. Plans, blocks, operations and operation items
retain owner-only rules. A draft cannot overwrite recorded placement.

`host/` is a **trusted host wrapper**, separate from the guest. Use `CalendarPorts::new` in
`Application::open_extended_with`. It reads and writes the seven existing Calendar preference keys
through the authenticated data context, plus the fixed writeback-policy key on time-block mode changes.
It also reads the actor's saved locale timezone and clock format.
`with_references` accepts actor-scoped public Tasks and
Briefing projections; no other module's tables are queried here. Without those projections,
drafts containing task references or a source run fail before committing. The returned task
shape is `{task:{id,ownerUserId}}`; the briefing shape is `{run:{id,ownerUserId}}`. The later
composition must provide real public adapters and validate full source-run provenance before
exposing the original HTTP create route. These projections use the declared read-only host
resources `calendar.task-reference` and `calendar.briefing-reference`, accepting only an `id`.
They are host-injected public-interface projections, not installed-package API dispatch.
No People data is read by this slice.

## Build and verify

Use the project's existing Rust toolchain with its `wasm32-unknown-unknown` target. Set
`CALENDAR_RUSTUP_HOME` if it is in a task-local Rust home. No tool is installed by these scripts.

```sh
modules/calendar/tools/check.sh
scripts/run-gate.sh start --gate ./modules/calendar/tools/gate.sh
scripts/run-gate.sh wait --follow
```

`check.sh` builds the native tests and both Rust Wasm libraries, compares pure data behavior with the
existing TypeScript implementation, and loads the shipped component with the real host.
The package builder wraps the pure core library in the existing `moss:module` component ABI
without WASI imports. It uses `wasm32-unknown-unknown`, rather than the spec's proposed
`wasm32-wasip2` compiler target; the shipped artifact is still a component. This avoids adding
a binding generator or a second WASI interface to the host. This target choice must remain
visible when the combined package build is standardized in the final slice.

The disposable database gate additionally downloads and installs a locally signed test
registry package, exercises real Wasm data calls, checks draft revision conflicts/rollback,
and runs the same foreign read/write assertions with row security removed and restored.
Those temporary fixtures are not UI or second-device proof.
The tool suite compares installed Wasm with the production TypeScript handlers on the
same disposable database: successful values and rejection/rollback outcomes. The host
sanitizes guest errors, so error text and status parity are not established. Its Tasks
projection is an explicit test stand-in. A heartbeat
fault witness removes and restores guest owner predicates around the same shared-event
exclusion assertion. The full checkpoint and remaining parity work are recorded in
`docs/superpowers/specs/2026-11-08-rust-calendar-js54-report.md` from the repository root.

To emit an unsigned registry archive after `check.sh`:

```sh
cargo +1.95.0 run --locked --offline --manifest-path modules/calendar/host/Cargo.toml \
  --bin calendar-package -- \
  /tmp/js48-host-target/calendar-guest/wasm32-unknown-unknown/release/moss_calendar.wasm \
  /tmp/calendar.mosspkg
```

A production registry must sign the digest using its approved first-party publisher. Tests
use fresh ephemeral keys and do not establish a production publishing configuration.

## Packaged screens checkpoint

The UI is a Rust/Leptos crate in `ui/`. It uses the shared module UI kit and authored
Calendar CSS, receives account data exclusively through the parent MessagePort bridge,
and keeps the iframe opaque. The module declares its screen, navigation, settings and
feature metadata. Display choices use account-scoped package KV under `calendar.ui-view`;
they cannot alter automation permission or provider data. This replaces device-local
storage for these choices, because the opaque iframe cannot safely use app-origin storage.

Builds use separate host, guest and UI targets. Set `CALENDAR_UI_TARGET`,
`CALENDAR_UI_DIR` and `CALENDAR_BINDGEN_TARGET` to choose scratch directories.
The existing project-local `rust-spike/ui/bindgen` helper generates the browser module;
no CLI is installed. Packaging requires the generated directory in `CALENDAR_UI_DIR`.

For a disposable **synthetic-account** browser check, claim a dev port, generate shared
assets and launch `tools/ui-live.sh` through `scripts/run-gate.sh`. Set
`CALENDAR_BROWSER_PORT`, `CALENDAR_SHARED_DIR` and `CALENDAR_BROWSER_DONE` (a scratch
sentinel path). Creating the sentinel stops the fixture; it also expires after half an
hour. This uses a real signed registry installation, database, component and iframe,
but does not provide sign-in, production shell composition, provider execution or
second-device HTTPS proof. It binds only to loopback intentionally. Do not use it as a
production server or represent it as final Calendar acceptance.

## Signed-in HTTPS Calendar composition (part 4)

The host crate's optional `web` feature provides `web::router(app, network, origins, shared)`.
It consumes the already installed `Application`, the existing `moss_network::web::Network`,
that network's exact configured HTTPS origins, and the generated shared-asset directory.
The caller still owns database bootstrap, signed registry installation, TLS and shutdown.
Calendar's pages are `/calendar` and `/settings/calendar`; data requests go through
`/api/m/calendar/`. Original `GET /api/calendar/events`, `GET /api/calendar/events/:id`
and `GET /api/calendar/briefing-settings` URLs also dispatch through the installed
package with the same authenticated actor. Other original routes are not aliased.
The parent's presentation bridge supplies the requested event ID; account data is
still read through installed routes. A successful refresh updates open details or
closes them when the event is absent; a failed refresh retains the loaded snapshot.
This is a Calendar-only composition, not the full Today/chat shell.

The parent uses the actual signed-in actor and the opaque module bridge. Verified package
assets and generated shared CSS/fonts are static code and are served without account cookies,
with host/sharing checks and the package's sandbox/CORS policy. Only this static route accepts
an opaque `null` origin. The existing network boundary still guards private pages and API calls.
Use the configured origins passed to `Network`, never request-supplied origins. Keep the
shared-asset directory dedicated to generated public CSS/fonts and theme files.

For a disposable real-sign-in browser run, build the package with `check.sh`, generate shared
assets with both `rust-spike/module-ui/build-assets.py` and
`rust-spike/shell/assets/build-assets.py` into the same scratch folder, then run:

```sh
CALENDAR_SHARED_DIR=/tmp/calendar-shared CALENDAR_HTTPS_PROOF_DIR=/tmp/calendar-https \
  scripts/run-gate.sh start --gate ./modules/calendar/tools/signed-live.sh
scripts/run-gate.sh wait --follow
```

Set the same `CARGO_TARGET_DIR`, `CALENDAR_UI_DIR` and `CALENDAR_CORE_WASM` paths used by the
build. The runner claims/releases its port, generates temporary fixture credentials and TLS
files, checks HTTPS and account isolation, and exercises the real package in this task's
Herdr browser. It removes credentials and the TLS private key at shutdown. Local browser
certificate-error tolerance is only for this generated disposable certificate; HTTPS clients
also verify the certificate explicitly. A LAN-address request made on this same computer and
a phone-width viewport are **not** a physical second-device result. Full parity, writable
automation settings, providers/jobs, production trust and full-shell/chat composition remain open.

On hosts where Chrome cannot use its sandbox, pass `AGENT_BROWSER_ARGS=--no-sandbox`
to the runner so every task-browser command uses the same launch setting. Run the live
check after the full gate on a loaded machine. Its browser assertions include authored
grid styling, shared font tokens and loaded events before the offline/retry probe.

## Read-contract parity checkpoint (part 5)

`tools/http-oracle.ts` runs the production TypeScript Fastify routes with the real
repositories and runtime-role data contexts against the gate database. Installed
Wasm comparisons cover owner, unrelated user and administrator before sharing,
after a view grant, and after revocation. They compare status and full response
bodies for event list, event detail, missing event and briefing settings. The
signed-live runner checks both URL prefixes after real password sign-in and
exercises event links, detail refresh and cached-event removal in the visible UI.
Its direct fixture row changes are synthetic cache setup, not provider execution.
Malformed UUID errors, every HTTP method/error, provider-backed paths and full
Calendar parity remain unproven. Existing privacy fault witnesses still run in
`gate.sh`; the new read comparisons do not replace those controls.

## Editable briefing settings (part 6)

Version 0.6.0 replaces the read-only summary with account lookahead, prep-task and
time-block controls. PATCH on both `/api/calendar/briefing-settings` and the installed
prefix uses the verified package. The trusted wrapper accepts only the seven existing
setting fields, writes their existing preference keys and updates the fixed Calendar
writeback-policy key when time-block mode changes. Settings and policy commit together
only after a successful guest call; errors roll them back. Preference revisions match
the original repositories. There is no general key or owner override.

The screen saves each choice, reloads confirmed values, retains them after a failed
save and allows another attempt. Auto grants standing permission to create tasks or calendar blocks without asking.
The existing app shares these preferences and may act on that permission. This Rust
version saves the choices without running providers, tasks or jobs; the briefing
source-behavior switch and old-screen replacement remain open.

The disposable gate compares valid write sequences against the production TypeScript
handler with its real policy adapter, including stored values and revisions for owner,
foreign user and administrator. Preferences add their own read/write RLS fault witness
and failed-guest rollback check. Rust rejects unknown fields and requires typed values. The original Fastify route
strips extra fields and can coerce string or null lookahead values; that malformed-input
behavior and exhaustive error-message equivalence remain different. Signed-live additionally saves
through the real UI, reloads, checks persisted policy, disconnects the browser for a
failed save and retries. A phone-width screenshot and same-host LAN check still do
not prove physical second-device access or production certificate trust.

## Screen parity checkpoint (part 7)

The trusted Calendar preference adapter projects only the assistant name from
`persona.bundle` alongside the existing locale projection. The display route applies
the original name normalization to valid stored names; it never returns persona text.
The installed tests compare different account names and repeat the foreign-name assertion
with preference RLS removed/restored on the disposable database. The existing five-table
read/write privacy witnesses are retained.

`tools/signed-live.ts` checks both account projections, personalized screen wording,
narrow-week today positioning, resize and retained horizontal scroll through the real
installed opaque frame after password sign-in. Fixtures are synthetic database records;
there is no provider call or response interception. The full Calendar gate and this
signed-in runner still use the commands above. Build both shared asset bundles into
the same dedicated scratch folder, and retain the same browser launch arguments for
open and CDP discovery.

This is still a checkpoint: all original HTTP contracts/errors, provider tools and jobs,
plan execution/recovery, writable automation, external status, full Today/chat shell and
replacement of the old screen remain open. A phone-width browser and same-host LAN
requests do not establish physical second-device access or trusted production HTTPS.
No global tool or wit-bindgen is installed by this part.

## Event dates and Day legend (part 8 checkpoint)

Version 0.8.0 keeps all-day exclusive ends and timed local-midnight ends off the next
day in event details. Default English event-date and toolbar-range wording match the
production Calendar model. The Day legend shows event swatches and counts today’s
held blocks; Week has no count note and Month has no event-type legend. These are
cache presentations, not evidence of provider execution. Native regressions and the
UI differential harness cover midnight, multi-day, leap-day, year-boundary and
timezone cases. The signed-live runner checks the rendered details and legend.

Part 8 merged before PR 4079. This combined branch retains its date and legend
changes alongside part 7’s assistant-name and narrow-week work. Full Calendar parity, regional
formatting beyond default English, the old-screen switch and physical second-device
HTTPS remain required. The report retains the complete remaining list.
