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
allowing source-linked creation through the original HTTP envelope. These projections use the declared read-only host
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

## Day-plan preview (part 10 checkpoint)

Version 0.10.0 adds `POST /day-plans/:id/preview`, matching the production
preview route: revision check, selected-change validation, before/after
timing, task eligibility, deadline risk and overlaps between selected
changes. Task facts arrive through the existing `calendar.task-reference`
public link in `{task:{id,ownerUserId,status,dueAt}}` shape; a missing task,
another account's task and a missing adapter all read as unavailable, never
distinguished. Nothing is written and no provider is contacted. The
production route takes busy intervals from its provider-backed source
context; this host has no such adapter yet, so availability reports
`unavailable` and no calendar-busy conflict is claimed, exactly as the
production route behaves without that dependency. The original
`/api/calendar/day-plan`, `/api/calendar/day-plans`,
`/api/calendar/day-plans/:id/draft` and `/api/calendar/day-plans/:id/preview`
URLs now also dispatch through the installed package in the Calendar web
router. The disposable gate compares the installed preview against the
production TypeScript route for owner, foreign user and administrator:
status on every case, full body on success. Remaining provider tools and
jobs, apply/retry/recovery, shell/Today/chat composition, old-screen
replacement and physical second-device trusted HTTPS stay open.

## Startup recovery (part 9 checkpoint)

Version 0.9.0 keeps a shared loading state visible until Calendar or settings mounts.
Generated-JavaScript, bridge-import and Wasm failures show a recovery message; a
missing boot script retains the static loading guidance. **Reload page** lives in
the authenticated parent, preserves the current screen and event query, and opens
a fresh installed frame. The module remains a client of the server API.

The signed-live runner invokes `tools/startup-check.ts` against real installed
assets. It interrupts each download, verifies the visible fallback, removes the
fault, and reloads into the real event or settings screen. It includes phone-width
settings screenshots. These deliberate download faults do not substitute API
responses or account identity. The existing gate, parity comparisons and privacy
fault witnesses remain required. Full provider/tools/jobs parity, full shell/chat,
old-screen replacement and a physical second device over trusted HTTPS remain
open; see the canonical Calendar report and the part 9 checkpoint report.

## Original draft HTTP envelopes (part 11 checkpoint)

Version 0.11.0 accepts `date` on day-plan reads, creation and draft saves, while retaining
`localDay` for existing package callers. Supplying both fields is rejected. Creation with
an omitted timezone reads the actor's saved locale, falling back to the product's
America/Los_Angeles default. Saving requires an explicit timezone and current revision.
The aliases added in part 10 now accept these original write envelopes. Original-envelope
creation with a non-null `sourceRunId` returns unavailable until the public provenance
adapter is ready. Existing internal `localDay`/public API contracts are retained.

The installed oracle compares create, repeated create, focus-block and intent saves, stale
revisions and foreign/admin write refusal with production handlers and repositories.
It uses two saved account zones and the no-preference default. Generated plan/block ids
and the different fixture dates are normalized; successful values otherwise compare in
full. Rejection bodies, coercion edge cases and exhaustive validation parity are unproven.
The live runner writes through browser fetch after real sign-in, checks both URL prefixes,
reloads the saved plan and checks revision/foreign-write refusal. No day-plan editor is
added to the screen in this checkpoint. Enriched plan reads, source-run provenance,
provider tools/jobs/execution, shell/chat, cutover and physical second-device HTTPS remain open.

The first independent review found no blocker or major. Its null-timezone and blank
source-id validation differences are corrected: both now reject with bad request,
with status comparisons against production. The null-timezone validation test was
observed failing before correction. Two minor limits are retained explicitly:
existing `localDay`/public API source-reference behavior is unchanged and does not
establish full provenance validation; noncanonical timezone spelling and Intl-only
aliases can differ from production and are outside the proven timezone cases.
A browser API check is a fetch from a signed-in page, not a day-plan editor interaction.

## Cache-evict job (part 12 checkpoint)

Version 0.12.0 adds the `calendar-cache-evict-event` job (`target-item-id`),
matching the production worker. The host captures the account in the queue
envelope. The guest reads the event through the scoped query and deletes it
only when that account can see it, so another user or an administrator gets
`{"evicted":false}` and the row stays. The privacy rule has a failing-first
native test plus a database-backed installed test. The day-plan apply job
still needs the provider execution flows and stays open.

## Saved-plan read summaries (part 13)

Version 0.13.0 returns the original HTTP saved-read envelope: the stored plan,
current task summaries, unavailable task IDs, a source-run summary and its
availability flag. It resolves each task once in first-seen order across
priorities, corrections, commitments and blocks. Missing, malformed or unavailable
public reference projections leave the stored plan intact and report that
reference as unavailable. Public `getPlan` and create/save responses stay unchanged.

The trusted `References` composition must enforce actor visibility, including
explicit shares; concrete production adapters are not verified in this checkpoint. Its task projection supplies `id`, `title`, `status`, `dueAt`, `doAt` and
`effort`; its run projection supplies `id`, `briefingType`, `status` and `createdAt`.
Additional fields are not forwarded. Read-only source summaries do not authorize
source-linked creation, which still requires the full public provenance adapter.
The disposable comparison uses explicit public-interface stand-ins; real Tasks and
Briefings adapters, the day-plan editor and full Calendar acceptance remain open.

One error-path difference is retained: production fails a saved read when a public
lookup throws; this package returns the saved plan with that reference marked
unavailable. Null references, missing adapters and lookup faults all use that flag.
It describes what this read could resolve, not proof that the referenced record was
deleted. Exact public-adapter error parity remains open.

## Saved operation status (part 14)

Version 0.14.0 reads a saved apply operation at
`GET /api/m/calendar/day-plans/:id/operations/:operationId`, with the matching
original `/api/calendar/` URL. It returns selected item order, pending/completed
status, stored results and access-denied guidance without contacting a provider
or changing the plan. Invalid stored result extensions are rejected like the original HTTP schema.
The original owner-only operation policies are retained.
Native regressions, installed comparisons with the production TypeScript route,
and an installed read with row security removed/restored cover this addition.
The signed-in browser runner reads synthetic stored operation rows through both
URLs; this is API evidence from a loaded Calendar page, not an operation-status
screen or evidence that provider execution works.

The remaining acceptance list in the calendar report still applies. In particular,
apply/retry/recovery/confirm, actual worker dispatch, concrete public adapters,
full shell/chat and old-screen replacement, complete parity and a physical second
device over trusted HTTPS are unfinished.

This continuation adds the already declared Wasm target to a task-local Rust home
and installs no global tool or new dependency and does not change the module's client/server boundary.

## Event details screen parity (part 15)

Version 0.15.0 restores the existing Calendar detail panel's title marker,
time/date and duration grouping, location and attendee rows, status marker and
held-block note. It retains the shared modal lifecycle and existing account data
requests. Long titles and locations wrap within the panel.

The signed-in runner checks authored layout, long-location wrapping and dismissal
with focus return at desktop and phone widths. These are real installed-screen
checks on a disposable Rust server; phone width does not prove a physical second
device. Full-shell/chat integration, old-screen replacement, provider tools/jobs
and execution flows, complete parity and physical second-device trusted HTTPS
remain open as listed in the Calendar report.

## Event grid parity checkpoint (part 16)

Version 0.16.0 restores the production timed-event labels: title only below 44px,
time from 44px, and location from 58px in Day view. Week stays compact. Held timed
events use the authored marker and held all-day chips use the accent colour.
These are additive options in the published Leptos kit, rather than a copied
module-local primitive. The screen remains a client of the installed server API.

`check.sh` includes rendered comparisons with the real production React time grid
at both visibility boundaries, in Day/Week, both clock formats and accepted,
tentative and held states. The signed-in live runner checks real installed chips,
long-location clipping, all-day colours and opening details at desktop and phone
widths. Its events are synthetic cache rows; no provider request is performed.
The full Calendar gate still runs the installed API comparisons and failing-first
privacy witnesses. This checkpoint does not complete the old-screen switch,
providers, jobs/execution, full shell/chat, exhaustive parity or physical-device
HTTPS acceptance. See the Phase 5 report for the complete remaining list.

## Month presentation parity (part 17)

Version 0.17.0 restores the authored today number, first-of-month labels, equal
row sizing and the production minimum height. The existing screen always uses
five or six rows, including short February months. All-day and continuation
chips omit their time element. Date and overflow buttons open Day; chips open
event details. The published Rust kit owns these primitives; no host or API
change is needed.

The rendered comparison invokes the real React Month screen with its locale
provider and the Rust screen for empty and populated months, five/six rows,
clock formats and three timezones. It compares selected structure and labels,
not full pixels or all regional formatting. The signed-in live check exercises
Month layout, today styling and navigation at desktop and phone widths using
synthetic cache rows. Full Calendar parity and physical second-device HTTPS
remain open; see the phase report for the complete remaining list.

## Day and Week scroll positioning (part 18)

Version 0.18.0 opens Day and Week with the current time centered in the actual
visible grid, clamped at the start and end of the day. A changed-data refresh
retains the user's vertical position, including a deliberate scroll to midnight.
This uses the grid's measured height rather than a fixed desktop offset. The
screen remains a client of the installed server API.

The comparison checks Rust's pure initial-position calculation against the real
React grid's DOM scroll effect for three day counts, three heights and four times.
Wasm wiring and retention are checked separately by the signed-in runner at desktop
and phone widths and checks retained scroll after a synthetic cached event
changes on the disposable server. It does not substitute API responses.
Full cutover, provider tools/jobs/execution, full shell/chat, complete parity and
physical second-device trusted HTTPS remain open as listed in the phase report.
Month now reserves more minimum row height than the existing screen so three
event chips and the extra-events button stay inside their clipping container.
The live check verifies the whole overflow control fits before clicking it.
Part 19 below covers re-centering after a saved timezone change. Browser clamping
at controlled day-boundary times is not covered by the DOM comparison.

## Saved timezone positioning (part 19)

Version 0.19.0 recenters Day and Week around the current time when an ordinary
refresh receives a changed account timezone, matching the existing Calendar grid.
It discards the vertical position only for a different effective timezone. Later
refreshes in that same timezone retain deliberate scroll, including midnight.
Calendar remains a client of the installed server API through the frame bridge.

The signed-in runner changes the synthetic account's actual saved locale on its
throwaway database, without substituting responses or changing browser state.
It exercises Day and Week at desktop and phone widths, timezone-only refreshes,
a simultaneous cache update, and later same-zone scroll retention. Its screenshots
and failing-before/passing-after results belong in the task Proof artifact.
No provider, table, privacy policy, shared host or cross-module adapter changes.
The complete port and physical second-device trusted HTTPS remain open as listed
in the main Calendar report.

The Month click investigation captured a browser input offset equal to the clipped
screenshot's origin, despite correct button geometry and DOM hit testing. Month,
initial-scroll and timezone checks now capture the full viewport and crop evidence
off-browser afterward. The checks retain normal pointer clicks and all navigation
assertions. See the phase report and task Proof for the reproduction and final
full-gate, installed HTTPS UI and independent-review receipts.

## Toolbar parity (part 20)

Version 0.20.0 restores the existing grouped Day / Week / Month choices and the
Work week / Full week choices, with their selected states. Compact Previous and
Next arrows and the small Today button use the published Leptos kit and the
existing Park Press styles. The screen saves through the installed server API;
it remains a pure client. Controls wait for initial loading and a pending view save.

The rendered comparison invokes the real production React Calendar page and the
Rust toolbar for all views and both week choices. The signed-in runner exercises
Previous / Next / Today, saved Day cursor, Work week and Month after reload,
five/seven columns, Enter/Space activation, focus retained after saves and toolbar
bounds at desktop and phone widths, including 320px. Screenshots capture the viewport; crop outside the
browser. These checks do not prove all regional labels, full pixel parity,
full-shell cutover or physical second-device HTTPS. The phase report retains the
complete remaining list.

## Settings request validation parity (part 21)

Version 0.21.0 restores the original briefing-settings PATCH request normalization
on both original and installed URLs: scalar and singleton-array coercion, removal
of unknown fields, and the original field-specific validation messages. This normalization
belongs only to the HTTP guest route. The trusted preference port continues to
accept declared, typed fields only; it never accepts a request-supplied owner.

The pure schema differential covers 242 requests using Moss’s production central error handler. The installed matrix adds those
to the existing write sequences for owner, another user and administrator, compares
complete response bodies, final stored values/revisions/policy, and checks each
rejected request leaves storage unchanged. Existing failing-first privacy witnesses
remain in the full gate. The signed-in runner checks both URL prefixes from the
browser and reloads the real settings controls after accepted and rejected writes.
These are settings-contract checks; provider execution, full shell/chat, old-screen
replacement, complete Calendar parity and physical second-device trusted HTTPS
remain open. No new dependency, global tool or wit-bindgen is installed.

Malformed/empty JSON transport bodies and JSON `__proto__` parser rejection remain
unmatched; the settings matrix covers parsed JSON values.

## Apply reservation and route (part 24)

Version 0.22.0 ports the apply-batch reservation (`apply.rs`): the reviewed selection plus
every pending addition is frozen under one idempotency key, an exact replay returns the stored
batch after the plan moves on, a changed request or stale revision conflicts, and missing item
rows are repaired on replay. `POST /day-plans/:id/apply` validates the body and then answers 503
because execution needs a Connectors package; it writes nothing. The original takes a row lock
on the plan during reservation; the host runs each database call in its own transaction, so the
unique idempotency key and the revision check carry that protection instead.

## Briefing switch (part 30)

Version 0.25.0 adds the "Include calendar signal in briefings" switch to the Calendar
settings screen. It reads and writes the same per-account stored value the existing app
uses (`calendar.briefings` inside the account's source-behavior preferences, on by default)
through two new routes, `GET` and `PUT` `/briefing-source`, with body `{ "enabled": boolean }`.
The server binds the key; the package cannot name another preference. The shared preference
wrapper now passes calls it has no binding for to the next wrapper instead of failing them.

Live check on the real HTTPS server (`pnpm test:rust-calendar-server`): the switch starts on,
clicking it in the real browser sends the save, the server reports off, and the switch stays off
after a reload with the other settings untouched. Not covered: "Use for planning" and
"Write events back" (no consumer exists in Rust yet), the platform-wide source-behavior list,
and external-calendar status controls (need a Connectors package).
