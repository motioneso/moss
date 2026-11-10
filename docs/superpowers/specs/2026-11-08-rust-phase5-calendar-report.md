# Rust Phase 5: Calendar package and data foundation

Task JS-48, Card 525. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

**Historical JS-48 scope: approved slice one only.** The coordinator approved JS-48 keeping the package,
data, privacy proofs and host wrapper. Separate tasks own tools/jobs/execution and
screens/live proof/full parity. This report does **not** claim the full Calendar port,
HTTP parity, UI verification or second-device verification.

## What this slice implements

- `modules/calendar/` contains the package manifest, icon, changelog, SDK-only Rust guest,
  separate trusted host wrapper, archive builder, data differential harness and gate scripts.
- The guest lists/reads cached events, reads/creates day-plan aggregates, saves drafts with
  revision checks, and reads existing briefing settings. Draft saves retain recorded placement
  and reject attempts to replace it. One host invocation is one database transaction.
- All five original Calendar tables and fifteen original SQL files retain their identities.
  No existing SQL is edited or moved. The package build verifies every raw hash, and install
  retains the historical core ledger, including `0229a`.
- Three additive host compatibility repairs: freeze all four day-plan table ownerships;
  order the exact historical suffixed migration between its numeric neighbours; accept the
  exact existing `calendar_event` sharing identity without opening that namespace to other
  downloaded packages. New migration names remain numeric.
- The wrapper reads only the existing seven Calendar preference keys through the actor's
  data context. Public Tasks/Briefing reference projections are injected at the wrapper seam;
  absent adapters fail closed before a draft commits. No People or Tasks tables are read.
- The package app map describes only this data foundation. It advertises no screen, settings
  editor, chat tool or job handler. The TypeScript Calendar remains the active user-facing app.

## Integration boundaries for the next slices

The six package routes are storage interfaces, not a claim of matching the old HTTP envelope.
The UI slice must retain `date`, the default account timezone, task/source-run projections,
error contracts and other contextual response fields from the existing routes. The five public
methods are `listEvents`, `getEvent`, `getPlan`, `createPlan` and `saveDraft`.

The host wrapper's `References` seam needs real actor-scoped public adapters. Its projections
return `{task:{id,ownerUserId}}` and `{run:{id,ownerUserId}}`; the guest verifies the requested
identity and owner. Full briefing source-run eligibility and provenance belong to composition
before the original create route is exposed. Missing adapters return an unavailable result.
Authority-changing settings writes are deliberately absent until the action-policy bridge is
assembled. Operation and operation-item rows are retained and privacy-tested; their state
machines and execution are slice two.

The guest builds natively and as a pure `wasm32-unknown-unknown` core, wrapped as a real
`moss:module` component using only the already declared WAT tooling. This differs from the
spec's proposed `wasm32-wasip2` compiler target. The shipped component has no WASI imports;
this choice avoids adding a binding generator or exposing additional host interfaces. Keep
this difference visible when standardizing the combined Phase 5 build. Native and component
checks are included in the scoped CI job; database proofs run only through verify-gate.

## Verification

The scoped disposable verify-gate first completed with exit zero on the implementation's
dirty tree at base commit
`79c81b2fc`. Its input fingerprint was `2034974a2305`. This receipt does not cover the
subsequent Clippy-only boolean-expression change or this report, and it is not a receipt for
the final commit. The task Proof artifact records the final committed-code gate and review;
that evidence is kept outside the source tree to avoid changing the commit under test.

Observed checks from this work:

- Four native guest tests and forty-five differential cases against the existing
  TypeScript serializer/model passed after review fixes. These are scoped data checks, not
  full HTTP parity. The initial harness included six copied settings expectations; review
  removed those from the differential count. Settings reads retain native fixture checks
  and installed-package preference/actor checks, without a settings HTTP parity claim.
- The actual Rust Wasm component loaded in the real host. Packaging preserved all fifteen
  legacy SQL files. The signed local registry download/install test passed with retained
  rows, event sharing/revocation, actor-separated preferences, revision conflict, rejected
  save rollback, successful draft save and unavailable public-reference adapter rollback.
- All five table privacy assertions rejected unrelated users and administrators. The same
  read/write assertions were observed failing with row security disabled in the disposable
  database, then passing after restoration. Missing-actor reads and a forged parent insert
  were rejected. Owner reads and updates were successful controls. The Google fixture must
  include the existing Calendar scope for owner updates; production RLS was not weakened.
- Root lint, typecheck, formatting and file-size checks passed during implementation.
  Scoped tools typecheck passed. Guest and host Clippy with warnings denied passed after
  the final fixture style fix. Guest, host and module-host Rust formatting checks passed.
- The earlier host migration-order regressions were observed failing before their fixes
  and passing after. The module-host native suite passed.

Repeat the gate against the final reviewed commit before publishing proof. Commands:

```sh
modules/calendar/tools/check.sh
scripts/run-gate.sh start --gate ./modules/calendar/tools/gate.sh
scripts/run-gate.sh wait --follow
```

Set `CALENDAR_RUSTUP_HOME` for an already provisioned task-local compiler when necessary.
The scripts install nothing. Keep native guest and host Cargo output folders separate: the
standalone `rlib`/`cdylib` guest otherwise collides across different feature graphs in one target.

The discovery below remains the source inventory for the remaining slices.

## Existing behavior to retain

| Area                   | Reference and required behavior                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event storage          | `packages/calendar/src/repository.ts`: cached event identity, connector-scoped lookup/upsert, ordered visible events, overlapping-event context, mirror reconciliation and follow-through matching.                                                                                                    |
| Event responses        | `packages/calendar/src/serialize.ts`: preserve explicit `jarvisCreated: false`, the legacy focus-block ID fallback, mirror read-only status, unconfirmed state, all-day metadata and nullable fields.                                                                                                  |
| Event references       | `packages/calendar/src/event-resolver.ts`: UUID-v4 Moss IDs versus connector-scoped external IDs; missing, invalid and inaccessible references retain their current outcomes.                                                                                                                          |
| Calendar screens       | `apps/web/src/calendar/`: Day/Week/Month, saved view choice, timezone/time format, Today navigation, responsive grids, event peek, external-calendar status, loading/error/retry behavior and retained events after a failed refresh.                                                                  |
| Settings               | `packages/calendar/src/settings/index.tsx` and `routes.ts`: lookahead, prep-task and time-block modes, legacy preference fallback, retained confirmed values after failed saves, and the action-policy implications of automatic writeback.                                                            |
| Saved day plans        | `day-plan-model.ts`, `day-plan-repository.ts` and related routes: actor-owned plans and blocks, revision checks, evening intent, task references, drafts and explicit removal disclosure. Draft changes do not write provider events.                                                                  |
| Preview and execution  | `day-plan-preview.ts`, `day-plan-apply.ts`, `day-plan-execute*.ts`, `day-plan-change-approval.ts`: live preview, reserved batches, provenance, idempotency, current authority, approval, partial results, retry and recovery.                                                                          |
| Automation             | `day-plan-auto.ts`, `follow-through.ts`, `monitor-provider.ts` and `heartbeat.ts`: automatic planning, follow-through identity, owner-filtered heartbeat windows, freshness/revision/boundary semantics and monitoring.                                                                                |
| Provider writes        | `calendar-write-service.ts` defines the injected public write contract; the concrete composition lives outside Calendar. Retain create/delete/reschedule/readback semantics and current confirmation/attendee/scope rules. A direct database write is not equivalent to a provider write.              |
| People and Tasks links | Use declared public interfaces. `modules/people/PUBLIC_API.md` describes the intended People contract but explicitly says its package handlers are still being implemented. Day-plan task reachability currently uses an injected public lookup; do not replace it with another module's table access. |

The current thirteen HTTP declarations are:

- `GET /api/calendar/events`
- `GET /api/calendar/events/:id`
- `GET /api/calendar/briefing-settings`
- `PATCH /api/calendar/briefing-settings`
- `GET /api/calendar/day-plan`
- `POST /api/calendar/day-plans`
- `PATCH /api/calendar/day-plans/:id/draft`
- `POST /api/calendar/day-plans/:id/preview`
- `POST /api/calendar/day-plans/:id/apply`
- `GET /api/calendar/day-plans/:id/operations/:operationId`
- `POST /api/calendar/day-plans/:id/operations/:operationId/retry`
- `POST /api/calendar/day-plans/:id/operations/:operationId/recover`
- `POST /api/calendar/day-plans/:id/operations/:operationId/confirm`

The six chat tools are `calendar.heartbeatWindow`, `calendar.listVisibleEvents`,
`calendar.createEvent`, `calendar.deleteEvent`, `calendar.rescheduleEvent` and
`calendar.dayPlanDraft`. Preserve the manifest's separate chat app-action rules: confirmation
and settings that promote authority remain blocked on that path.

The two job kinds in `packages/calendar/src/jobs.ts` are `calendar.cache-evict-event` and
`calendar.day-plan-apply`. The latter reloads its reserved batch from metadata IDs and fails
closed without its injected execution service. Its provider calls deliberately run outside
one ambient database transaction. Queue retry/retention behavior also belongs in parity.

## Data and privacy obligations

Calendar's storage includes `app.calendar_events`, `app.day_plans`, `app.day_plan_blocks`,
`app.day_plan_operations` and `app.day_plan_operation_items`. The original manifest's short
`ownedTables` list names only events; it is insufficient as the Rust package inventory.
The module registry's migration directory discovers all fifteen files under
`packages/calendar/sql/`, including the day-plan migrations.

The event policies evolve across several migrations. `0020` adds explicit event shares;
`0066` includes worker access and connector-scope checks; `0087` strengthens update checks.
Event reads allow owner or explicit view access; updates allow owner or explicit manage
access, subject to their current checks. Events remain private by default. Cache deletion is
worker-only; the misleadingly named `0126_app_runtime_calendar_events_delete.sql` deliberately
adds no application DELETE grant. The day-plan tables use owner-only rules. Do not replace
these distinct rules with one generated generic policy.

The disposable database checks above exercise these policies for this data slice.
The combined Calendar acceptance obligations remain:

- Keep existing SQL byte-for-byte in its current directory, package it against the compiled
  hash inventory and retain the `core-legacy` ledger. Never edit applied migrations.
- Exercise owners A/B, an unrelated administrator and missing actor through actual Rust
  module calls and runtime-role queries. Check reads, mutation, forged owner/connector
  identity, pooling reuse and every Calendar-owned table.
- Test event view/manage sharing and revocation separately from owner-only day plans. An
  event share must not grant access to a day plan.
- Observe the privacy assertions failing after deliberately removing their protection in a
  disposable gate fixture, then passing with the protection restored.
- Recheck current actor/resource/approval state in jobs. Keep private titles, bodies,
  prompts and provider credentials out of queue payloads.

## Shared integration still needed

`rust-spike/module-host/EXTENDED_HOST.md` explicitly says its APIs do not connect module
screens to the authenticated shell. Inspection of `rust-spike/shell/app/src/main.rs` and its
Cargo manifest confirms that its private router currently serves shell, Today and chat,
without the module-host dependency or dispatch/frame/asset assembly.

HTTPS and sign-in already exist in `rust-spike/network/`; rebuilding them inside Calendar
would duplicate shared infrastructure. A shared integration owner must connect the module
host behind that existing boundary. The Calendar builder should consume that additive
integration on main and own only Calendar package files and its verification/report files.

The existing side-by-side harness can compare HTTP, runtime SQL, jobs and final rows. Its
default launcher builds the Phase 0b Tasks server, and its TypeScript fixture starts Tasks
workers. Calendar needs a scoped launcher/fixture that runs the real Calendar guest and
workers; running the existing Tasks cases would not prove Calendar parity.

## Approved build split

The coordinator approved this split after discovery commit `fe8af3b7f`. JS-48 owns only
the first slice. Keep final Calendar acceptance open until all three slices and their
combined live proof pass.

1. **Package and data path.** Create `modules/calendar/` using section 7 of the package spec:
   manifest, native/Wasm crate, SDK-only host access, exact legacy SQL inventory and a real
   signed install. Port event reads, serialization, settings and saved-plan storage. Add
   matching harness cases and failing-first database privacy controls for all five tables.
2. **Tools, automation and execution.** Port the six tools, two jobs, provider-write public
   service seam, focus scheduling, heartbeat/monitoring, plan preview, approval, apply,
   retry/recovery and follow-through. Prove response, row and job parity with the real guest.
   Preserve public People/Tasks dependencies and current action-policy boundaries.
3. **Screens and assembled proof.** Port existing screens and settings with the shared
   Leptos kit and opaque-frame bridge. Update package navigation/settings/features alongside
   the surfaces they actually serve. Exercise sign-in, package activation, Calendar reads
   and writes, chat actions and failure recovery in the real Rust UI, then on a second
   device through configured HTTPS and trusted origins.

Each slice needs its own bounded build brief and independent review. This slice ran only
disposable database tests; it started no app server or live browser session. No new tools
were installed and no build agents or merges were started. Workshop and Food remain excluded.

## Review follow-through

The first independent review found two major issues, addressed in this slice: blank draft
titles now clear to null and other JSON titles use the old string conversion; CI provisions
the already declared toolchain using the runner's existing rustup command instead of adding
a third-party action. The same title repro was observed failing before and passing after.
The real-Wasm save check also now saves a blank title.

The correction source and other enum fields are checked without trimming, and the copied
settings oracle was removed from the differential harness. Common IANA zones are covered
with UTC, Europe/London, America/New_York and Australia/Sydney. The review's remaining minor
timezone concern is explicit: unusual aliases and case variants accepted by JavaScript
Intl can differ from chrono_tz. Those are not proven equivalent and must be reconciled before
claiming full parity. Final review findings and their disposition are recorded in the task
Proof artifact, without changing the reviewed commit.

## Completion boundary and remaining slices

This report covers only the approved package/data/privacy/host-wrapper slice. The task's
Proof artifact and PR carry the final check receipts, independent review and explicit
Not proven list. Final acceptance uses the exact reviewed commit; this report does not
claim UI, second-device, execution or full Calendar parity.

Slices two and three retain the outstanding tools/jobs/execution and screens/live-device/
full-parity work described above. In particular, later builders must provide concrete
actor-scoped public-reference adapters, preserve the old HTTP context/envelopes and use the
shared authenticated host/shell integration. The manual component build target remains an
explicit build difference to resolve or standardize across the assembled package.

## JS-72 / part 4: signed-in Calendar composition checkpoint

Card 525. This continuation is bounded to Calendar-owned files. It consumes the shared host
on main, without changing sibling crates. The original full-parity and real second-device
acceptance requirements remain open; the old TypeScript screen is not switched off.

The host crate now offers an optional Calendar web router using the existing Rust Network
account/HTTPS boundary. It opens the installed Calendar and settings screens, dispatches the
package's declared routes as the authenticated actor, and offers sign-out. Synchronous installer
and guest calls run on a blocking executor with an eight-call admission bound. Failed page loads
and host failures return a retryable response without forwarding underlying diagnostics.

Opaque frames cannot authenticate their static module/Wasm/font requests with app cookies.
Calendar's composition therefore serves verified package assets and dedicated generated public
shared assets separately, preserving package CSP, sandbox and opaque-origin CORS headers.
The static route keeps configured-host and live sharing checks; private pages/API requests
continue through the unchanged Network guard. Trusted asset policy origins come from the
caller's network configuration. Package version 0.4.0 and its app map describe this boundary.

The `signed_ui` example and `signed-live.sh` runner use a disposable database through verify-gate,
a locally signed package, generated test accounts and a temporary TLS certificate. The runner
uses real Rust password sign-in and the task's visible browser; it does not inject an account
identity into Calendar requests. It also checks the listener through the machine's LAN address.
These fixtures are not an installed production application, the full shell, a trusted production
certificate or an actual second device. Check receipts and review findings belong in the task's
proof artifact. No `wit-bindgen` or new global tool is installed by this part.

Remaining work is the JS-60 list in
`docs/superpowers/specs/2026-11-08-rust-calendar-js60-report.md`, with the Calendar-only signed-in
page/own-package dispatch seam now supplied. Full shell/Today/chat integration, original HTTP
context/error parity, writable settings and authority policy, four provider tools, both jobs,
preview/apply/retry/recovery/follow-through, real public provider/reference adapters, full parity
harness acceptance and an actual second device over trusted HTTPS remain unproven.

The checkpoint review also records narrower composition limits: the Calendar router owns `/`
and `/today`, uses the Sage theme and maps host dispatch failures to a retryable 503. Shared
static assets must be generated public files in a dedicated directory; the router does not
inspect arbitrary directory contents for private material. Static requests retain configured-host
and sharing checks but do not use the private-request audit path. Full shell composition, theme
selection and original HTTP error parity remain follow-up work. The browser runner checks
server-side revocation of its old session after sign-out as well as a separate session staying valid.

Live screenshot inspection found that opaque-frame no-CORS stylesheet requests omit `Origin`
but carry cross-site fetch metadata. The initial static guard rejected them, leaving the
working controls unstyled. The same regression assertion failed with 403 before the fix.
The public static route now handles absent origins alongside opaque `null` origins; explicit
foreign origins, unconfigured hosts, disabled sharing and non-read methods remain checked.
The browser runner verifies both the Calendar grid layout and shared font tokens. It also
waits for real events after returning from settings before simulating a failed refresh, and
allows the debug sign-in redirect longer on loaded machines. Final receipts and review
disposition remain in the task proof; these fixes require a review round beyond the two
already recorded for the earlier commit.

## JS-78 / part 5: installed read routes and event-screen parity

Card 525. Working folder: `~/Jarv1s` task worktree. This continuation consumes the
merged part 4 checkpoint and stays in Calendar-owned files. The full remaining
execution/provider/automation work exceeds the brief's context bound; this part
will leave a reviewed checkpoint rather than claim final Calendar acceptance.

Planned work: preserve event deep links through the authenticated opaque-frame
composition; restore missing event-detail duration, attendee and status wording;
refresh an open event from successfully loaded data; route original Calendar read
URLs through the installed package; compare the three original read contracts
against the production TypeScript routes on the disposable database. Re-run the
Calendar gate, privacy fault witnesses and signed-in HTTPS browser check. Actual
second-device trust, full shell/chat, writable automation, provider tools/jobs and
full assembled parity remain acceptance requirements.

Live state and final receipts for this part are in its task Proof artifact; local
build output, fixture credentials and screenshots stay outside the repository.
No global install is authorized or performed. The existing task-local Rust/Wasm
compiler is reused; no wit-bindgen installation is needed for this slice.

### Delivered boundary

Package 0.5.0 adds event links on the Calendar-owned signed-in page. The parent sends
only the requested event ID over its existing presentation bridge; event contents
still come from installed account-scoped reads. Successfully refreshed events update
an open peek or dismiss it when absent. Failed refreshes retain the prior snapshot;
initial loads and explicit retries display progress; background refresh stays quiet. Details now include elapsed duration,
correct singular/plural attendees, and accepted/RSVP/observed/held status wording.

Three original GET URLs (event list, event detail and briefing settings) are aliases
for the existing installed dispatch. They retain the Network guard, installed
manifest, account enablement and guest transaction. Other original URLs and write
methods are not exposed by these aliases. The production TypeScript screen remains
active in the old application; this does not perform its full replacement.

The new HTTP oracle registers production Fastify routes with real Calendar and
preference repositories and runtime-role data contexts on the gate database. The
installed test compares status and complete bodies for the three read contracts,
including a missing event and all-day, tentative, Outlook-mirror and Moss-block
serialization in event lists, for owner, unrelated user and administrator before a
view grant, with that grant, and after revocation (thirty-six comparisons). The
signed-live runner additionally compares both URL prefixes after real password
sign-in (sixteen comparisons), then exercises linked and refreshed event details.
These are scoped differential checks, not the complete parity-harness acceptance.
Task/source-run projections are deliberately unexercised by this read oracle.

The new details regression was observed failing on the old rendering: duration was
absent and a single attendee appeared as `1 people`. The same test passed after the
fix. The UI model adds twelve comparisons against production `fmtDur`, including
hour boundaries and signed inputs. Existing data/tool/UI comparisons and all five
tables' failing-first privacy witnesses remain in the Calendar gate. Final gate,
root checks, live browser receipts and review verdict belong to this task's Proof
artifact, tied to the exact tested commit rather than a stale receipt in source.

### Still required for final Calendar acceptance

The remaining list from part 4 still applies: ten other original HTTP contracts and
all untested errors/defaults; four provider tools and both jobs; plan preview,
authority/approval, apply, retry/recovery, follow-through and monitoring; real public
reference/provider adapters; writable automation and external-calendar status; full
shell/Today/chat integration; old-screen replacement and full assembled parity.
No malformed-UUID or exhaustive HTTP-error equivalence is claimed. The current
Calendar-only composition and local fixture do not prove installation of the whole
Rust app, a production trusted certificate, or a physical second device. A same-host
LAN-address request and phone-width screenshot remain distinct from that requirement.

Builds reuse the existing scratch Rust 1.95.0 compiler and Wasm target. Only existing
lockfile dependencies are prepared in the worktree. No global tool, new dependency,
wit-bindgen installation or sibling crate change is part of this checkpoint.

The first independent review found no blocker or major and four minor follow-ups.
This part suppresses recurring background-refresh announcements, expands the HTTP
fixtures beyond plain events and gives the live polling assertions a longer bound.
The remaining assistant-name gap is explicit: the package still says Moss where
the old screen uses the configured assistant name. Final review disposition is
recorded on the reviewed commit and in the task Proof artifact.

The expanded HTTP fixtures exposed a harness-only numeric representation mismatch:
Rust metadata serializes zero as `0.0`, while the TypeScript response uses `0`. The
comparison now applies JavaScript numeric semantics to both complete JSON bodies;
array order, fields and nonnumeric values remain compared. The live runner also
passes its required browser launch flags through the supported environment setting.

## JS-82 / part 6: editable briefing settings

Card 525. Work stays in Calendar-owned files in the `~/Jarv1s` task worktree.
This checkpoint replaces the read-only settings summary with saved lookahead, prep-task
and time-block controls. The installed PATCH route will preserve the seven existing
preference keys and the time-block writeback policy, atomically under the signed-in
actor. Invalid input must fail before writes, and unsuccessful guest calls must roll
back the settings transaction. The app map will describe this boundary.

Verification will compare valid write sequences with the production TypeScript route
and its real policy adapter, exercise foreign-user and administrator isolation with
RLS removed and restored, and save/reload settings through the real signed-in UI.
Full provider execution, source-behavior controls, Today/chat shell assembly, old-screen
replacement, exhaustive error/coercion equivalence and physical second-device trusted
HTTPS remain outside this bounded checkpoint and required for final acceptance.
No new global tools or dependencies are planned; builds reuse the existing scratch
Rust/Wasm toolchain. Proof receipts and review disposition will accompany the checkpoint.

### Delivered settings boundary

Package 0.6.0 exposes the original settings PATCH URL and the installed route.
Lookahead, prep-task and time-block choices save per account, reload from existing
preferences, retain confirmed values after failure and allow retry. Time-block mode
also saves the existing writeback tier in the same transaction. The host validates
all fields independently of the guest and commits only after successful completion.
Concurrent account saves can wait for each other without blocking call finalization.
The screen discloses that Auto grants standing permission honored by the existing
app, which shares these preferences and may act on them. This Rust version does not
run a provider or job. The briefing source-behavior switch is still open.

The new PATCH regression failed first with 404 before the route was implemented.
The disposable oracle adds 33 valid write-response comparisons across owner, foreign
user and administrator, then compares stored preference values, revisions and policy
with the production TypeScript repositories. Existing stored modes override legacy
booleans just as before. A failed-guest witness checks settings and policy rollback.
The preferences read/write assertions fail with RLS removed and pass after restoration.
Existing five-table privacy fault witnesses remain required in the same gate.

The builds use the existing scratch Rust 1.95.0/Wasm toolchain and lockfile dependencies.
No global installation, new package dependency or wit-bindgen installation was needed.
Builds and proof files live outside the worktree. Final tested-commit receipts and
independent review disposition are in the task Proof artifact, not inferred from an
earlier checkpoint. This remains a checkpoint, not full Calendar acceptance.

### Review fixes and proof limits

The settings transaction now has a call-wide timeout, a PostgreSQL statement timeout
and a bounded commit. A lock-contention regression verifies expiration while the
account lock is still held, with no saved preferences or permission. Concurrent-save
fault tests use fresh host-minted scopes with an explicit test budget and always
release the first transaction before asserting. Integer-valued lookahead inputs are
stored as integers, and successful refreshes clear old save messages. Existing UI
clippy warnings in time formatting are resolved without changing its output.

Rust deliberately rejects unknown fields and untyped values. Fastify strips extra
fields and can coerce string or null lookahead values; exhaustive malformed-input
parity is still open. The preferences RLS fault witness tests actual SQL reads and
writes, while installed PATCH comparisons check owner-preservation and rejection
without removing that host validation. The browser failure probe disconnects before
the request: database commit failure and a lost response after a committed save are
not proven. A later refresh reconciles an uncertain save with stored preferences.

The first live run reached the disposable HTTPS listener but exceeded its auth
request deadline. The runner now allows extra time for unoptimized Rust password
verification on loaded development machines. This changes only the proof runner,
not production password settings or network deadlines. Final receipts, screenshots,
review disposition and remaining limits are attached to the task Proof artifact.

## JS-86 / part 7: account naming and narrow-week screen checkpoint

Card 525. Part of issue 4027. This continuation works in the task worktree under
`~/Jarv1s`, consuming current main without changing shared host or sibling sources.
The outstanding provider/execution/shell work requires more than the permitted context
budget, so this is a bounded checkpoint and does not claim final Calendar acceptance.

Package 0.7.0 projects the signed-in account's assistant name from the existing
`persona.bundle` preference. The trusted host selects only that field from the persona
row; the guest applies the existing name cleanup and default behavior. The Calendar
legend, held-event details and settings heading use it. Persona text is not part of the
projection. The native screen test also checks escaped personalized held-event wording.
The new route regression was observed failing before implementation: the requested
assistant name was null rather than the account name. It passed with the projection.

Week screens restore the existing scrolling explanation and region description, and
bring today into view on first load, navigation, week selection and resize. Ordinary
background event refresh does not request a new position. Day does not add an unnecessary
keyboard stop, and Month omits the event-type legend, matching the original screen.
The installed HTTPS runner checks the personalized settings and legend, narrow-week
position, resize and a user's scroll position across a refresh, alongside the prior
real sign-in, event links/details, offline retry, signed-out session and account checks.

The data oracle adds comparisons against production `normalizePersonaSettings` for
ordinary names, defaults, blank/control/markup characters, accents, emoji, whitespace
and length limits. These are scoped comparisons, not exhaustive Unicode equivalence:
legacy names cut inside a UTF-16 surrogate pair remain outside the proven set. The
installed database test reads different names for two accounts and the default for an
unrelated administrator, observes the same foreign-name assertion fail with preference
RLS disabled, restores RLS and requires it to pass. All five Calendar tables retain their
existing failing-first foreign read/write witnesses. No applied SQL file changes.

Verification receipts, screenshots and independent review are recorded in the task's
Proof artifact and PR against the final checked commit. All database checks use
`scripts/run-gate.sh` and a disposable server. Both shared asset generators write to one
scratch directory for the live run. The existing Rust 1.95.0 Wasm target and project
binding helper are reused. Dependencies come only from existing lockfiles. No global
tool, new dependency or wit-bindgen installation is performed.

The first live attempt reached signed-in Calendar but its new visibility assertion
failed because TypeScript inserted a helper into a nested browser callback. The
runner now polls from Node with a self-contained browser callback. This correction
and the subsequent main rebase happened after both allowed independent reviews;
the checkpoint needs another review round before Ready. The earlier reviews found
no blocker or major. Height-only resizing still recenters today and remains a minor
follow-up. Part 6 merged during final verification. This branch is rebased onto it,
retains the editable settings and their tests, and adds account naming to that screen.
The merged settings checkpoint also fixes the earlier time-format Clippy findings.
The combined package is checked again; earlier receipts prove only their recorded commit.

### Remaining acceptance work

The part 5 remaining list still applies: the other original HTTP contracts and untested
errors/defaults; four provider tools and both jobs; preview, authority/approval, apply,
retry/recovery, follow-through and monitoring; concrete public provider/reference
adapters; source-behavior controls and external-calendar status; full shell/Today/chat
composition; old-screen replacement and complete assembled parity-harness acceptance.
The original held-block count note and event-color swatches are now retained from merged part 8.
Editable lookahead, prep-task and time-block settings come from the merged part 6
checkpoint and remain intact. This part does not claim that inherited work as new.

Actual physical second-device sign-in/UI over trusted HTTPS is still unproven. This
machine has no attached ADB device or configured SSH target, and available tailnet peers
do not advertise SSH access. No device was commandeered or new remote tool installed.
The disposable certificate, same-host LAN request and narrow viewport used by the live
runner remain explicitly distinct from that final acceptance requirement. Production
installation, trusted certificates and Windows/macOS execution also remain unproven.

## JS-91 / part 8: event dates and Day legend checkpoint

Card 525. Work stays in Calendar-owned files in the `~/Jarv1s` task worktree.
At the start, main contains part 6; part 7 is still open as PR 4079. This continuation
does not copy that branch's account-name projection or narrow-week positioning.
The full remaining port exceeds the brief's context bound, so this is another
bounded checkpoint, not final Calendar acceptance.

Package 0.8.0 corrects event-detail date ranges at midnight and retains all-day exclusive
ends, compares displayed date and toolbar range wording against the production screen
model, and restores the Day legend's held-block count and authored event swatches.
Verification includes the Calendar parity and failing-first privacy gate, plus real
signed-in installed-package HTTPS UI checks. No provider response is mocked to make a
screen pass. The module remains a client of the server's installed package API.

The existing task-local Rust 1.95.0/Wasm compiler and lockfile dependencies are reused.
Build caches are copied to this task's scratch directory before use. No global tool,
new dependency or wit-bindgen installation is performed. Final receipts and review
disposition belong in the task Proof artifact against the tested commit.

The midnight-detail regression failed first: a meeting ending at local midnight
displayed the next calendar day as part of its range. The corrected native rendering
passes. The UI differential harness adds 90 event-date and 36 toolbar-range comparisons
against the production TypeScript model, covering midnight (including the existing
minute-level rule), all-day, multi-day, DST, leap-day and year boundaries in five zones.
Native legend cases cover singular/plural, zero held blocks, another day, Week, Month
and escaped assistant-name text. The live runner creates real synthetic cache rows
and compares the rendered date labels with the production model, then checks shared
swatches and the Day count at desktop and phone width. These remain scoped checks.

The part 5 acceptance list remains open: remaining HTTP contracts/errors/defaults,
four provider tools and both jobs, plan preview/approval/apply/recovery/monitoring,
real public reference/provider adapters, source-behavior controls, external-calendar
status, full shell/Today/chat composition, old-screen replacement and complete
assembled parity. Regional date/time formatting beyond the default English locale
is also not established. A phone-width browser and a same-host LAN request do not
prove physical second-device access or trusted production HTTPS.
This task found no attached Android device or configured SSH alias for that check.

The first review's claimed UTC mismatch was rejected: `host/examples/signed_ui.rs`
already saves the owner's UTC locale before publishing the fixture. The live runner
now asserts that stored timezone explicitly before creating dated events. Minor
coverage gaps remain: malformed end-time date labels and regional weekday prefixes
are not compared by the added date/toolbar oracle. Neither is claimed as proven.

## Part 7 integration after part 8 merged

PR 4079 now includes main’s part 8 date wording, exclusive-end handling, Day legend
count and swatches alongside part 7’s account assistant name and narrow-week behavior.
The shared legend receives the account name; both sets of native and browser assertions
are retained. The package stays at main’s version 0.8.0. The earlier third review covered
the pre-integration commit; this conflict resolution needs a fresh review receipt.
Only quick checks are rerun for this requested integration. Earlier full gate and HTTPS
receipts remain proof of their recorded commit, not of the combined merge commit.
The full acceptance and physical second-device limitations above remain open.

## JS-93 / part 9: installed startup recovery checkpoint

Card 525. Package 0.9.0 adds loading and failure guidance to the packaged Calendar
and settings screens, plus a parent **Reload page** control that keeps the current
screen and event query. The module remains an API client. Implementation, proof
approach and the unchanged final acceptance list are recorded in
[the part 9 report](2026-11-08-rust-calendar-js93-report.md).

A failing-first live check interrupted the actual old bundle's Wasm request and
observed no startup fallback. The same installed-screen checker verifies recovery
after Wasm, generated-JavaScript, boot-script and settings-bridge download faults.
It removes each fault, uses the parent reload and checks the real screen and event
link. Desktop and phone-width screenshots are evidence from the disposable Rust
HTTPS/sign-in fixture, not a physical second device or production trust. Final
receipts and independent review belong in the task Proof artifact.

The full Calendar port exceeds this continuation's context bound. This is a clean
checkpoint, not final Calendar acceptance; the remaining provider/tools/jobs,
public adapters, execution/recovery, shell/Today/chat, old-screen replacement,
complete assembled parity and physical-device HTTPS work remain required. Builds
reuse the existing Rust/Wasm scratch toolchain and lockfiles, with no new dependency,
global tool or wit-bindgen installation.

## JS-95 / part 10: day-plan preview checkpoint

Package 0.10.0 ports the production day-plan preview route
(`POST /day-plans/:id/preview`) into the guest: revision check,
selected-change validation with the production messages, before/after
timing, task eligibility, deadline risk and overlaps between selected
changes. Task facts arrive through the existing public task-reference
link; a missing task, another account's task and a missing adapter all
read as unavailable and are never distinguished, which keeps the privacy
rule intact. The module stays a pure client of the server API and writes
nothing during a preview.

The production route feeds calendar-busy conflicts from its
provider-backed source context. No such adapter exists in this Rust host
yet, so the ported preview reports calendar availability as unavailable
and claims no busy conflicts, matching the production route's own
behavior when that dependency is absent. It never presents cached data
as a live provider read.

The Calendar web router now also dispatches the original
`/api/calendar/day-plan`, `/api/calendar/day-plans`,
`/api/calendar/day-plans/:id/draft` and `/api/calendar/day-plans/:id/preview`
URLs through the installed package. The app map gains the
`calendar.day_plan_preview` feature declaration.

The disposable gate compares the installed Wasm preview against the
production TypeScript route on the same gate database for the owner, an
unrelated user and an administrator: status on success, revision
conflict, unknown field, missing block, block without a pending change
and invalid revision cases, with full body comparison on success. The
existing five-table privacy fault witnesses stay in the same gate.

Two minor review differences are accepted for this checkpoint. The
malformed-id cases compare status only, because the production side
answers those with a framework validation body that is not a stable
comparison target. The preview treats a task owned by another account
as unavailable even when that task is view-shared with the actor; the
production read can see a view-shared task. Which rule shared tasks
follow must be settled when the real public Tasks adapter lands in
this host, since no production reference adapter exists here yet.

This is another bounded checkpoint, not final Calendar acceptance. The
remaining acceptance list is unchanged: four provider tools and both
jobs, apply/retry/recovery/confirm execution, concrete public provider
adapters, source-behavior controls and external-calendar status, full
shell/Today/chat composition, old-screen replacement, complete assembled
parity and a physical second device over trusted HTTPS. Builds reuse the
existing task-local Rust 1.95.0/Wasm scratch toolchain (`CALENDAR_RUSTUP_HOME`
pointing at a home that carries the Wasm target) and lockfiles. No global
tool, new dependency or wit-bindgen installation was performed.

## JS-99 / part 11: original draft request parity checkpoint

Card 525. This continuation recovered uncommitted day-plan work, then integrated the
merged part 10 preview checkpoint from main. Work stays in Calendar-owned files in
the `~/Jarv1s` task worktree. Package 0.11.0 remains a pure client of the server API.
This is a bounded checkpoint, not the full Calendar port.

The installed routes accept the original `date` field on creation and draft saves,
plus the existing package `localDay` field. Ambiguous requests with both are rejected.
Creation without a timezone reads the actor's locale and uses the
product's America/Los_Angeles fallback. Saves require an explicit timezone. Original
source-linked creation deliberately returns unavailable pending the public Briefings
provenance adapter; no other module's tables or provider credentials are read.
The existing part 10 HTTP aliases and preview route remain in place. The app map
records the expanded write support and the source/enriched-read limitations.

The failing-first installed check used the baseline package and the production
TypeScript create route on the same disposable database: production returned success,
while installed Rust returned bad request for the original date envelope. The
inherited adapter's UTC fallback was also corrected before keeping it. The expanded
oracle uses real production handlers/repositories, two account timezone preferences
and the no-preference default; successful create, save and repeated-create responses
compare in full after normalizing generated ids and the separate fixture dates.
Stale-revision and foreign/admin rejection statuses are compared; rejection wording
and exhaustive malformed-input equivalence are not established. Foreign reads and
unchanged owner drafts are checked separately. Existing failing-first five-table
privacy witnesses remain required by the scoped gate.

Verification uses `scripts/run-gate.sh` for the full Calendar gate and signed-in live
runner. The live check sends real browser requests through both URL prefixes after
sign-in and loading the installed Calendar screen, then checks saved values, repeated
creation, stale revisions and a different signed-in account's refused write. It does
not add or prove a day-plan editor. The existing screen/settings/startup checks run
alongside it. Exact command outcomes, final tested commit and review disposition are
recorded in the task Proof artifact rather than borrowed from prior parts.

Builds reuse the existing Rust 1.95.0/Wasm toolchain and declared lockfiles, with build
caches copied into this task's scratch directory. Both shared asset generators target
one scratch folder. No global tool, new dependency or wit-bindgen installation is
performed. The disposable certificate, same-machine LAN request and phone viewport
do not prove physical second-device access or trusted production HTTPS.

Remaining: enriched plan read responses; complete validation/coercion/error parity;
source-run provenance and real public Tasks/Briefings/provider adapters; the four
remaining provider tools and both jobs; apply/retry/recovery/confirm and monitoring;
source-behavior controls and external-calendar status; full shell/Today/chat and the
old-screen replacement; complete assembled parity; physical second-device HTTPS.

The first independent review found no blocker or major. Its null-timezone and blank
source-id validation differences are corrected: both now reject with bad request,
with status comparisons against production. The null-timezone validation test was
observed failing before correction. Two minor limits are retained explicitly:
existing `localDay`/public API source-reference behavior is unchanged and does not
establish full provenance validation; noncanonical timezone spelling and Intl-only
aliases can differ from production and are outside the proven timezone cases.
A browser API check is a fetch from a signed-in page, not a day-plan editor interaction.

## JS-102 / part 12: cache-evict job checkpoint

Package 0.12.0 ports the production `calendar.cache-evict-event` queue worker
as the `calendar-cache-evict-event` job. The account comes from the host's
queue envelope. The guest reads the event with the scoped query and deletes it
through the same typed query only when visible, so a foreign user or an
administrator gets `{"evicted":false}` and the owner's row survives. Queue
retry options use host defaults; the production values (two retries, ten
second delay, five minute retention) are not yet declarable.

Evidence: three native guest tests written failing first (visible event,
invisible event never deleted, unknown queue and extra fields rejected before
any host call) and one database-backed installed test through the disposable
gate. A first attempt used the untyped delete operation and failed against the
real host, which is why the guest uses the typed query. Production deletes on
the worker database role (SQL 0113); the installed test cannot open the host on
that role (no catalog access), so the disposable database gives the app role an
simpler owner-only delete rule. Production also requires the event's connector account to belong to the actor and be a calendar account (SQL 0113); the stand-in omits that condition. Real worker-role dispatch by the host job
runner is therefore not proven here. The Wasm target for the
1.95.0 compiler was added to a scratch Rust home (`CALENDAR_RUSTUP_HOME`); no
global install, no new dependency, no wit-bindgen.
The jobs capability (enqueue) is declared in the manifest to match the Tasks package pattern; nothing in Calendar enqueues this job yet, and the capability is to be dropped or used when the day-plan apply flow lands.

Still open: the four provider tools, the day-plan apply job and its
apply/retry/recovery/confirm flows, concrete public provider adapters,
source-behavior controls, full shell/Today/chat composition, old-screen
replacement, complete assembled parity and a physical second device over
trusted HTTPS.

## JS-107 / part 13: saved-plan read summaries checkpoint

Card 525. Package 0.13.0 fills the original saved HTTP read envelope through the
installed Calendar API and existing URL aliases. It keeps the saved plan unchanged,
deduplicates references in first-seen order and projects live task/source summaries
through the existing scoped public-reference interface. No other module tables,
provider credentials or host internals are accessed by the guest. Only summary
fields are returned; unavailable adapters, missing references, mismatched IDs and
malformed summaries report unavailable beside the saved plan. The trusted public
adapter owns visibility, so an explicitly shared task may be summarized on a read.
This does not extend the existing owner-only task rule on draft edits or previews.

The native regression was observed failing before implementation: the saved read
omitted `unavailableTaskIds`. The same regression now checks ordered, deduplicated
summaries, unchanged saved titles and removal of extra projection fields. Separate
cases cover an absent plan and failed/mismatched reference projections. The full
Calendar gate retains its existing failing-first five-table privacy witnesses and
compares the installed Wasm response against production TypeScript on the same
throwaway database for owner, unrelated user, administrator, missing day and
present/missing source references. Task/run projections in that comparison are
explicit stand-ins, not proof of concrete production adapters or sharing adapters.
The signed-in live runner checks complete saved-read envelopes through both URL
prefixes after exercising the real installed Calendar screen. These requests are
browser API calls, not interactions with a day-plan editor.

This is a bounded checkpoint, not final Calendar acceptance. Remaining: concrete
public Tasks/Briefings/provider adapters and full provenance; complete validation,
coercion and error parity; four provider tools; day-plan apply job and
apply/retry/recovery/confirm execution; worker-role cache-evict dispatch; source
behavior and external-calendar status controls; full shell/Today/chat; old-screen
replacement; complete assembled parity; physical second-device trusted HTTPS.
The full port exceeds this continuation's one-context bound. Exact fresh check
receipts and independent review are recorded in the task Proof artifact.

Builds reuse the existing scratch Rust home with Rust 1.95.0 and its Wasm target,
and copy existing build caches into this task's scratch folder. Project dependencies
are restored offline from the declared lockfile in this worktree. Both shared asset
builders target one scratch directory. No global tool, new dependency or
wit-bindgen installation is performed. Disposable test TLS, a same-computer LAN
request and phone-width screenshots do not establish physical-device access or
production certificate trust.

The first independent review found no blocker or major. Two minor limits are retained:
lookup failures are reported as unavailable beside a readable saved plan, whereas
production throws and fails the request; and visibility through concrete public
reference adapters (including explicit shares) is not yet verified. The README makes
the adapter's visibility obligation and the error-path difference explicit. A future
adapter must demonstrate that another account's private task cannot be summarized,
with a failing-first installed privacy check. The installed comparisons below use
owner-scoped stand-ins and do not discharge that production-adapter requirement.

## JS-112 / part 14: saved operation status checkpoint

Card 525. Package 0.14.0 adds the original read-only apply operation status route
through the installed API and the Calendar web composition's original URL alias.
A plan id and operation id must identify the same visible apply batch. The
response retains selected item order, stored item results, pending/completed
status and access-denied guidance. Stored result extensions are rejected like
the original HTTP response schema. Legacy array snapshots and current snapshots
with explicit intent are supported. No provider action, queue change or plan
mutation is performed. This is a bounded checkpoint, not final Calendar acceptance.

The native route regressions were observed failing against the previous
implementation (missing route: success returned not found, malformed ids were
not validated). The same tests pass after the change. Additional native cases
cover empty batches, nonbatch headers, unreadable snapshots/results, multiple
item pages and result-schema rejection. Installed-Wasm comparisons call the real
production TypeScript route on the same disposable database for owner, unrelated
user and administrator; both snapshot formats, pending/unknown/failed/applied
results, denial guidance, wrong plan, absent operation and malformed ids are
covered. Framework-generated malformed-id and response-serialization error bodies
are excluded; their status codes are compared. Other validation/coercion/error cases remain unproven.

The installed privacy witness reads the same operation as another account before,
with the two operation tables' row security disabled in the disposable fixture,
and after restoration. It must observe the privacy violation without protection
and refusal again after restoration. The full gate also retains the original
failing-first foreign read/write witnesses on all five Calendar tables. Production
SQL and privacy rules are unchanged.

The signed-in HTTPS runner loads the real installed Calendar screen and then
reads synthetic stored operation rows from that page through both URL prefixes.
It checks pending/completed status, denial guidance, result-schema rejection and foreign
and wrong-plan refusal. These are browser API requests, not interactions with a
new status screen. Direct fixture rows model saved progress; they do not establish
provider execution. Exact fresh checks, review and commit are recorded in the
task Proof artifact.

Builds reuse copied build caches and provision Rust 1.95.0 with the declared
Wasm target in this task's own scratch Rust home. The earlier scratch homes
proved incomplete or were removed before they could be copied. Dependencies are restored
offline from the declared lockfile in this worktree. Both shared asset bundles go
into one scratch directory. No new dependency, global tool or wit-bindgen installation
is performed. A same-machine LAN request, disposable TLS certificate and phone-width
browser are not a physical second device or production certificate trust.

Remaining: concrete public Tasks/Briefings/provider adapters and full provenance;
complete validation/coercion/error parity; four provider tools; day-plan apply job
and apply/retry/recovery/confirm execution; worker-role cache-evict dispatch; source
behavior and external-calendar status controls; full shell/Today/chat; old-screen
replacement; complete assembled parity; physical second-device trusted HTTPS.

The first independent review found no blocker or major. Its app-map mismatch is
corrected by describing the original plain HTTP errors without inventing a new
response code; the selection lookup now uses a map, and the operation oracle runs
last so its synthetic state cannot affect later checks. A page-size concern is not
a current defect: the host does not impose a smaller limit, and native coverage
reads through a full page into the next. The inherited chat-policy integration
remains open alongside the full chat composition.

The assembled package check caught an invalid camel-case template parameter:
the host deliberately accepts lowercase template names only. Calendar now uses
`operation_id` internally while preserving the original concrete URL. A focused
package regression verifies host template acceptance and parameter resolution;
the shared host is unchanged.

The first full part-14 gate found a real mismatch: Rust stripped extra stored
result fields, while Fastify's `anyOf` serializer rejects them with HTTP 500.
A focused probe through the original DTO parser and response schema confirmed
this. A new native regression failed before the correction and passes after it;
Rust now rejects extra fields and invalid optional result fields. The installed
matrix includes both a valid denial and the extension rejection (210 comparisons).
Exact fresh rerun outcomes belong in the Proof artifact; earlier partial runs
are not passing full-gate evidence. Strict host Clippy also reports a pre-existing
`useless_vec` in the unchanged day-plan oracle; allowing only that lint passes.

## JS-118 / part 15: event details screen checkpoint

Card 525. Package 0.15.0 restores the existing Calendar detail panel's authored
structure: title marker, time and duration, subordinate date and timezone,
location and attendee rows, status marker and the held-block note. The shared
modal lifecycle stays in the kit. Long titles and locations wrap inside the
panel; no provider, database, host or cross-module interface changes are needed.
The module remains a client of the server API through its opaque frame bridge.

The screen regression checks the authored structure and escaped event text.
The signed-in runner exercises real installed event details at desktop and phone
widths, including loaded synthetic event data, computed row layout, long-location
wrapping, Escape and Close dismissal, and focus return to the event. Fresh test
results, screenshots and independent review belong in this task's Proof artifact.

Builds use a task-local copy of an existing Rust 1.95.0 home with its declared
Wasm target, task-local build outputs and dependencies restored offline from the
project lockfile. Both shared asset builders write into one scratch directory.
No global tool, new dependency or wit-bindgen installation is performed.

This is a bounded screen checkpoint, not final Calendar acceptance. Remaining:
concrete public Tasks/Briefings/provider adapters and full provenance; complete
validation/coercion/error parity; four provider tools; day-plan apply job and
apply/retry/recovery/confirm execution; worker-role cache-evict dispatch; source
behavior and external-calendar status controls; full shell/Today/chat; old-screen
replacement; complete assembled parity; physical second-device trusted HTTPS.
Disposable TLS, a same-computer LAN request and a phone-width browser cannot
establish production certificate trust or physical second-device access.

## JS-124 / part 16: event grid labels checkpoint

Card 525. Package 0.16.0 restores the production timed-event label rules: a title
only below 44 pixels, a time from 44 pixels, and a location from 58 pixels in Day
view. Week remains compact. Held timed events show the authored marker and held
all-day events use the accent colour. The shared published Leptos kit gains
additive options because a missing primitive must not be forked inside a module.
No shared host, data, provider or cross-module interface is changed. Calendar
remains a pure client of the installed server API through the opaque frame bridge.

The new native regression was observed failing on the old implementation because
a short event still rendered a time row. It passes with the corrected labels,
escaped location text, held marker and all-day colour. Rendered differential
comparisons call the real production React CalendarTimeGrid with its saved locale
provider and the Rust TimeGrid, covering the visibility boundaries, Day/Week,
both clock formats and accepted/tentative/held states. They compare selected chip
markup, not the entire screen or pixel layout. The signed-in live runner checks
real installed chips and detail opening at desktop and phone widths using
synthetic cache events, without response substitution. Exact fresh check results,
screenshots and independent review are recorded in the task Proof artifact.

Build outputs and an existing Rust 1.95.0 home with its Wasm target are copied into
task-local scratch directories. Declared dependencies are restored offline from
the lockfile. Both shared asset builders write to one scratch directory. No new
dependency, global tool or wit-bindgen installation is performed.

This remains a bounded screen checkpoint. Still required: concrete public
Tasks/Briefings/provider adapters and full provenance; complete validation,
coercion and error parity; four provider tools; day-plan apply job and
apply/retry/recovery/confirm execution; worker-role cache-evict dispatch; source
behavior and external-calendar status controls; full shell/Today/chat; old-screen
replacement; complete assembled parity; physical second-device trusted HTTPS.
Disposable TLS, same-computer LAN requests and phone-width screenshots do not
establish physical-device access or production certificate trust.

## JS-131 / part 17: Month presentation checkpoint

Card 525. Package 0.17.0 restores Month's authored today marker, first-of-month
labels, explicit equal rows and production minimum height. Five rows remain
the minimum, including February; six rows appear when needed. All-day and
continuation chips omit the time element. The shared published Rust kit owns
the date and chip primitives. Calendar remains a pure client of the installed
server API through its opaque frame bridge; data, providers and the shared host
are unchanged.

The new native rendering regression was observed failing on the old screen
because its date number used a class absent from the authored stylesheet.
The production differential invokes the actual React Month screen, locale
provider and Rust rendering for empty/populated months, five/six rows, both
clock formats and three timezones. It compares row declarations, date markers,
headers, chip order/text/colour and overflow labels, not complete screen pixels
or regional formatting. The signed-in live runner checks installed Month rows,
first-of-month labels, today's computed highlight, date/overflow navigation to
Day and chip navigation to details at desktop and phone widths. Fresh outcomes,
screenshots and independent review are recorded in the task Proof artifact.

Build outputs and an existing Rust 1.95.0 home with its declared Wasm target are
copied into task-local scratch directories. Declared dependencies are restored
offline from the lockfile. Both shared asset bundles use one scratch directory.
No new dependency, global tool or wit-bindgen installation is performed.

This is a screen checkpoint. Still required: concrete public Tasks/Briefings/
provider adapters and full provenance; complete validation, coercion and error
parity; four provider tools; day-plan apply job and apply/retry/recovery/confirm
execution; worker-role cache-evict dispatch; source behavior and external-calendar
status controls; full shell/Today/chat; old-screen replacement; complete assembled
parity; physical second-device trusted HTTPS. Disposable TLS, a same-computer
LAN request and a phone-width screenshot do not prove physical-device access
or production certificate trust.

## JS-135 / part 18: Day and Week scroll positioning checkpoint

Card 525. Package 0.18.0 opens Day and Week around the current time using half
the actual visible grid height, matching the existing screen's scroll effect.
The browser clamps the result at the beginning and end of the day. Changed-data
refreshes retain the user's vertical position, including zero at midnight. No
provider, data, host or cross-module boundary changes are required; Calendar
remains a pure client of the installed server API through its opaque frame bridge.

The new differential compares Rust's pure initial-position calculation with the
real production React grid's DOM scroll effect for three day counts, three heights
and four times. It does not execute Wasm wiring or test browser scroll clamping. The
signed-in live runner measures the real installed grid at desktop and phone
widths, then changes a synthetic cache row on the disposable server and checks
that the next ordinary refresh preserves the user's position. Fresh red/green
results, full Calendar gate, live checks and review are recorded in the task's
Proof artifact. The original failing-first privacy witnesses remain in the gate.

The build uses a task-local copy of an existing Rust 1.95.0 home with its declared
Wasm target and build caches. Dependencies are restored offline from the project
lockfile. Both shared asset builders write into one scratch directory. No new
dependency, global tool or wit-bindgen installation is performed.

This is a bounded screen checkpoint. Still required: concrete public Tasks,
Briefings and provider adapters and full provenance; complete validation,
coercion and error parity; four provider tools; day-plan apply job and
apply/retry/recovery/confirm execution; worker-role cache-evict dispatch; source
behavior and external-calendar status controls; full shell/Today/chat; old-screen
replacement; complete assembled parity; physical second-device trusted HTTPS.
A disposable certificate, same-computer LAN request or phone-width browser does
not establish physical-device access or production certificate trust.
The live run also reproduced Month overflow clicks being intercepted by the next
row. Its minimum row height now reserves room for the date, three chips and the
extra-events button. This deliberately exceeds the legacy minimum; the rendered
comparison still checks other Month structure and labels against production.
The live runner checks the entire overflow button fits its event list before clicking.
Part 18 covered initial positioning; the part 19 checkpoint below adds timezone changes.

## JS-142 / part 19: saved timezone positioning

Card 525, package 0.19.0, PR #4141. Day and Week reset their remembered scroll only
when the effective saved timezone changes; ordinary refreshes retain user scroll.
The installed-screen regression changes saved locale and cache rows in the
throwaway server at desktop and phone widths. Baseline failed by 474.033 pixels.
The app map describes the new positioning. Calendar remains a pure server API client.

The live runner pins a late-day primary event and follows Month overflow to Day,
waiting for the view save before that click. The prior direct-chip lookup depended
on the current hour and could select an event behind the three visible chips.

An earlier full live run passed the timezone cases but failed Month pointer clicks.
A focused installed-screen reproduction captured the actual pointer: the button
center was at local y=379.390625, but the delivered pointer was at y=518.390015,
on the following week's cell. The 139-pixel difference exactly matched the
screenshot clip's vertical origin. All clipping ancestors contained the button,
and DOM hit testing at its center returned the button. Increasing row height
would not address this input offset. Reloading between device cases did not fix it.
The Month, initial-scroll and timezone helpers now capture the full viewport;
proof images are cropped afterward, outside the browser. Normal pointer checks,
geometry assertions and all overflow/date/detail navigation checks remain.
Diagnostic reproduction log: `task_142_rust_port_phase_5_calendar_modu-20261109-174601-PYYt2j.log`.

Ben paused verification for CPU load, then resumed it on 2026-11-09. Final full-gate,
normal-refresh HTTPS live, focused Month repetition, scoped checks and independent
review receipts are published in the task Proof artifact; use its recorded commit
and fingerprints for the final verdicts. Root type checking also passed on 4740e9ec3.
An earlier run crossed UTC midnight and failed the startup-selected timezone shift;
that harness boundary remains unproven. Strict CSR Clippy still reports the existing
work-week toggle formatting lint; allowing only that lint passes. No dependencies,
global tools or wit-bindgen were installed for this part.

Full-port work above remains open: provider tools/jobs and execution, concrete public
adapters and provenance, complete validation/error parity, full shell/Today/chat,
old-screen replacement and physical second-device trusted HTTPS. Same-computer LAN
requests and phone-width rendering do not prove another physical device or production
certificate trust. This PR is the bounded saved-timezone screen checkpoint.

## JS-160 / part 20: authored toolbar checkpoint

Card 525. Package 0.20.0 restores the existing grouped View and Week type controls,
selected choices, compact Previous / Next arrows and small Today button. Additive
Segmented and IconButton components live in the published Leptos kit and consume
the authored Park Press classes. Calendar uses the same installed display-settings
API and remains a pure client of the server. No data, host, provider or module
boundary changes are needed. The shared asset builder now includes the existing
form-layout stylesheet after the kit stylesheet, matching the web app cascade;
without it the segmented controls lacked their authored padding and height.

The rendered differential invokes the real production React Calendar page for
Day, Week and Month with both week choices. It was observed failing on the prior
Rust toolbar's button sizing and grouping before the presentation was replaced.
The signed-in runner checks navigation, saved Day cursor, saved Work week and
Month across reloads, five/seven grid columns, Enter/Space activation, selected
states, focus retained after saves and control bounds at desktop, 390px and
320px. The same keyboard assertion failed before the focus fix: disabling the
selected control during a save dropped focus to the document body. The bridge
restores that connected control only when focus remains in the document, no
dialog is open and the user has not focused something else. It does not restore
old scroll positions. Evidence and fresh check
verdicts, including the full Calendar gate's existing failing-first privacy
witnesses, are recorded in the task Proof artifact. These tests do not assert
full pixel parity or every regional label.

Declared JavaScript dependencies are restored offline from the lockfile. Builds
use copied scratch caches and a task-owned Rust 1.95.0 home. The prior task
scratch home disappeared during the first gate, so the declared toolchain and
Wasm target were restored into this task’s scratch directory. The first gate’s
test cases passed but its final doctest could not start; that failed receipt is
not counted as a green gate. Both shared asset bundles use one scratch
directory. No global tool, new dependency or wit-bindgen installation is performed.

This is another bounded screen checkpoint. Still required: concrete public
Tasks/Briefings/provider adapters and full provenance; complete validation,
coercion and error parity; four provider tools; day-plan apply job and
apply/retry/recovery/confirm execution; worker-role cache-evict dispatch; source
behavior and external-calendar status controls; full shell/Today/chat;
old-screen replacement; complete assembled parity; physical second-device
trusted HTTPS. Phone-width rendering, disposable TLS and a same-computer LAN
request do not establish another physical device or production certificate trust.

## JS-166 / part 21: settings request validation parity

Card 525, package 0.21.0. The briefing-settings PATCH route now retains the
original Fastify normalization: allowed scalar and singleton-array coercion,
removal of additional fields, and the original field-specific HTTP 400 validation messages for
invalid requests. For example, `lookaheadDays: "1"` saves one day; an unknown
`ownerUserId` is discarded. Normalization happens at the HTTP guest boundary;
the trusted preference writer retains its typed field allowlist and authenticated
actor. Calendar remains a pure client of the server API.

The baseline differential failed on an extra owner field: Rust returned 400 where
the original removes the field and returns 200. The 242 schema comparisons use Moss’s production central error handler and pass
after the correction, including booleans, nulls, singleton arrays, body shapes,
radix/exponent/whitespace numeric strings and mixed invalid fields. The installed
matrix compares these requests plus the eleven existing valid write sequences
for owner, another user and administrator (759 comparisons), final stored values,
revisions and writeback policy. Each rejected installed request also checks that
storage is unchanged. Original privacy fault witnesses remain in the full gate.
The signed-in browser runner sends accepted and rejected requests through both
URL prefixes and reloads the real settings controls to verify confirmed values.
Fresh full-gate, root-check, browser and independent review verdicts belong in
this task's Proof artifact; this report does not substitute for those receipts.

Builds use task-local copies of existing Rust 1.95.0/Wasm and build caches.
Project dependencies are restored offline from the declared lockfile; both
shared asset builders write into one scratch directory. No new dependency,
global tool or wit-bindgen is installed.

This is a bounded parity checkpoint. Still required: provider tools and jobs,
execution flows, concrete public adapters and provenance, the other unverified
validation/error contracts, full shell/Today/chat, old-screen replacement,
complete assembled parity and physical second-device trusted HTTPS. Disposable
TLS, a phone-width browser and same-computer LAN requests do not prove another
physical device or production certificate trust.

Independent review found that the initial oracles omitted Moss’s central error
handler and therefore expected Fastify’s generic validation envelope. The oracles
now install `setMossErrorHandler` before registering routes. The corrected test was
observed failing before Rust was fixed to return the original type/enum messages
and first-invalid-field ordering. The final proof records only corrected receipts.
Malformed/empty JSON transport bodies and JSON `__proto__` parser rejection remain
unmatched and unproven; the request matrix covers parsed JSON values only. The
validation rules remain in both the HTTP adapter and strict preference writer;
the production-schema differential guards their intended agreement.

The final installed run exposed one pre-existing privacy assertion that still
expected an owner-field request to be rejected. After all 759 production comparisons
passed, that assertion failed because both endpoints correctly discard the field.
It now expects success while retaining the unchanged-owner-storage assertion; the
strict host-interface forged-owner rejection remains separate. The app-map wording
now limits its validation claim to well-formed JSON bodies. These final corrections
need a further review round; the task's two allowed rounds were already used.

The first live run reached the settings contract helper and exposed TSX's generated
`__name` reference inside the serialized browser callback. The helper now uses a
direct request loop without a nested function; the API assertions are unchanged.
The failed live receipt is retained as failing-first evidence, and a fresh live
run and final review are required for this browser-only test correction.
Re-centering after a saved timezone change remains open; this slice covers initial positioning.

## JS-173 / part 22: upcoming-events tool checkpoint

Adds the guest logic for `calendar.listVisibleEvents` and routes the tool name in the
package handler. It reads only through a public Connectors call (`listCalendarContext`),
resolves the named windows today and tomorrow in the saved account timezone (default
unchanged), projects events, accounts and gaps with the original field names and writes the
one-sentence summary only when the answer is complete and live (no cache, gap or truncation).
Saved zones may be IANA names or fixed offsets such as +05:30; a zone this build cannot read
fails closed instead of guessing a day. A missing Connectors package makes the call fail closed with the standard unavailable error.

The manifest does not advertise the tool or declare the Connectors requirement yet. A hard
requirement would stop Calendar installing until a Rust Connectors package exists, and the
host refuses the call without it. Enabling it is a manifest-only change (add the `connectors`
requirement, the `api` call capability and the tool entry) once that package ships.

Checks: Calendar guest tests (12 in the tools suite, including day-boundary and
fail-closed cases) pass offline with Rust 1.95.0. No new dependency, no wit-bindgen use.

Still required: the other three provider tools (create, delete, reschedule) and the day-plan
apply job; concrete public Tasks, Briefings and Connectors adapters; apply/retry/recovery/
confirm execution; source behavior and external-calendar status controls; full shell and chat;
old-screen replacement; complete assembled parity; physical second-device trusted HTTPS.
Nothing in this slice was exercised through a live UI or second device.

## JS-181 / part 23: provider tool logic and live server run

Adds the guest logic for `calendar.createEvent`, `calendar.deleteEvent` and
`calendar.rescheduleEvent` in `modules/calendar/src/provider_tools.rs`, routed from the package
handler. The guest validates input, resolves the create window (morning 9-12, afternoon 12-17,
evening 17-21, default tomorrow morning, duration clamped to 15..480, default title "Focus time")
in the saved account timezone, and sends every provider effect through public Connectors calls
(`createCalendarEvent`, `deleteCalendarEvent`, `rescheduleCalendarEvent`). A missing Connectors
package fails closed with the standard unavailable error and writes nothing. Delete and
reschedule return the original "required" result shapes for missing or unreadable input before
any provider call. The timezone resolver is now shared with the upcoming-events tool.

Differences from the original: a `start` or `newStart` is read as RFC 3339, a date, or a
zoneless date-time taken as UTC; an unknown `partOfDay` is refused. The approval-card text, the
freeze of a relative day across the approval gap, and the confirmation policy are host work and
are not part of this slice. The three tools are not advertised in the manifest yet, for the same
reason as part 22 (no Rust Connectors package).

Checks: five new guest tests in `tools.rs` (window bands, fixed offsets, bad input, the exact
Connectors requests, fail-closed) pass with Rust 1.95.0.

### Live run on the real server

New gate `pnpm test:rust-calendar-server` (through `scripts/run-gate.sh`): builds the real
`moss-shell` and the network helper, publishes the packed Calendar package through a signed
folder registry, installs it with the canonical installer, starts the server over HTTPS with a
modules file, signs up an owner through the real sign-up route, and calls the routes. Result:
no sign-in gives 401; the owner's cached event is listed and readable by id; an unknown id
gives 404; a day plan is created and read back; briefing settings read with defaults. The
cached event row is inserted by the test the way a sync would leave it; no response is rewritten.

Not proven: Calendar screens on the real server (it serves module routes only, no frames), the
provider tools end to end (no Connectors package), a second account over HTTP, a second physical
device. Still required: the day-plan apply job, concrete Tasks/Briefings/Connectors adapters,
apply/retry/recovery/confirm execution, source behavior and external-calendar status controls,
full shell and chat, old-screen replacement, complete parity.

## JS-185 / part 24: apply-batch reservation and apply route

Adds `modules/calendar/src/apply.rs` (package 0.22.0). `reserve` freezes the reviewed selection plus
every pending addition under one idempotency key: trimmed, deduplicated, sorted intent; entries in
plan order; unknown or change-less selected blocks refused (400); stale revision on a new key (409);
exact replay returns the stored batch even after the plan revision moves; any changed request under
the same key (409); item rows missing after a partial write are repaired on replay (unique per batch
and block). `POST /day-plans/:id/apply` is now declared in the manifest. It checks the body (strict
fields, uuids, key length) and answers 503 "day plan apply is unavailable" without writing, because
execution needs a Connectors package. The route does not call `reserve` yet, so no pending batch can
be left that nothing can run.

Review round 1 fixes: the plan revision is re-read after the blocks are read, so a draft save that lands mid-reservation conflicts instead of freezing the newer draft; replay matches items by their frozen change and never recreates an item for a deleted block; the route refuses a null or repeated selection and an empty operation key like the original.

Open after round 2: a draft save raises the revision before it rewrites blocks (existing behavior of the save path), so a reservation that expects the new revision while another save is still rewriting blocks could freeze a half-written draft. The client that made the save only learns the new revision after it finishes, so the window needs two clients. Closing it needs one host transaction across the save and the reservation, which the host does not offer yet. The route does not call `reserve`, so nothing is exposed until that exists.

Differences from the original: the original holds a row lock on the plan while reserving; the host
runs each database call in its own transaction, so the unique idempotency key, the revision check and
replay repair carry that protection. The 202 approval gate and tier policy are host work, not built.

Checks: ten guest tests in `tests/apply.rs` (in-memory host) plus the existing guest suites pass with
Rust 1.95.0. The live gate `pnpm test:rust-calendar-server` passes against the real HTTPS server: apply
without sign-in 401, valid body 503 with the fail-closed message, unknown field 400 with
`day_plan_invalid`, plus the earlier event, day-plan and settings checks. The gate now waits for the
server's background module load (the first module route answered 503 for most of a minute on a cold
start, then 200); that cold-start delay is worth a look in the host work.

Not proven: Calendar screens on the real server, execution of any apply, retry, recovery or
confirmation, a second account, a second physical device. Still required: Connectors, Tasks and
Briefings adapters, the apply job and execution, source behavior and external-calendar status
controls, full shell and chat, old-screen replacement, complete parity.

## JS-191 / part 25: operation routes and Calendar screens on the real server

Package 0.23.0 declares `POST /day-plans/:id/operations/:operation_id/retry`, `/recover` and `/confirm`.
Each checks the request like the original (retry: non-empty distinct uuid `itemIds`, no other fields;
recover: absent or empty body; confirm: non-empty `approvalId`; ids must be uuids) and then answers 503
"day plan apply is unavailable" without reading or writing, because execution needs a Connectors
package and confirm needs stored approvals the host does not offer. Guest test:
`retry_recover_and_confirm_validate_then_fail_closed`.

Shared frame fix: the module frame page now keeps the frame at least window height. Before, Calendar's
Month grid was cut off at 160px because the grid sizes to its own viewport.

### Live run (real HTTPS server, signed-in owner, real Chrome, no rewritten responses)

`pnpm test:rust-calendar-server` now also runs `modules/calendar/tools/server-browser.ts`. Passing in a
real browser: sign in through the real route; the Month screen shows the owner's cached event (seeded
for today, as a sync would leave it) inside the viewport; the event details open and close with Escape;
Week and Day switch. Retry, recover and confirm answer 401 without sign-in, 503 with it, 400 for a bad
selection. Screenshots were checked by eye in the task proof.

### Open finding

Changing "Look ahead" on the settings screen through the real control did not reach the server within
30 seconds (the server still returned 2). The route itself works through the gate's direct calls and
the earlier packaged-settings gates. Cause not yet found; the browser step is removed from the gate
until it is diagnosed. The last gate run with the frame fix passed everything before that step.

### Not proven

Provider execution, retry/recover/confirm running a change, second account, second physical device
(phone or laptop over LAN/tailnet), settings save through the UI on the real server.

## JS-200 / part 26: settings save was a false success on the real server (fixed)

Cause of the open finding in part 25: the server composition did not include the Calendar
preference wrapper, so the briefing-settings PATCH wrote to a module-private store and answered
200 "saved" while the account's real preferences never changed (a later read still gave the
default of 2). The server now wraps its ports with `CalendarPorts` (Calendar-only; it answers
calls from the Calendar module and passes everything else on), so settings and the account
timezone come from the real account preferences. `moss-shell` depends on the Calendar host crate
for this; a module-neutral preference binding would remove that coupling later.

Live (real HTTPS server, real Chrome, nothing rewritten): the gate opens the settings screen,
changes Look ahead to Today only and Prep tasks to Off through the real controls, sees the
"Settings saved." status, reads the values back from the server (0 and off), and reloads to see
Look ahead still 0. Before the fix the same step failed with 2 instead of 0. Run through
`pnpm test:rust-calendar-server` via `scripts/run-gate.sh`; the browser step is back in the gate.

Not proven: provider execution, the four provider tools end to end, retry/recover/confirm running
a change, a second account, a second physical device. Still required: Connectors, Tasks and
Briefings adapters, the apply job and execution, source behavior and external-calendar status
controls, full shell and chat, old-screen replacement, complete parity. These need a Rust
Connectors package first, which does not exist yet.

## JS-205 / part 27: unattended day-plan step (package 0.24.0)

Ports the original scheduled-run planning step (`day-plan-auto.ts`) as two public Calendar methods,
`reserveAutoPlan` and `findUnfinishedBatch`, in `modules/calendar/src/auto_plan.rs`. They are for the
future Briefings package; nothing in Calendar's own screens calls them.

`reserveAutoPlan` takes the run id, definition id, local day, zone and signals. Block-time intents
become automatic blocks and `suggest_time_block` signals become suggestions (prep takes the hour
before the meeting, other windows are capped to 15..120 minutes). Block ids are the original SHA-256
digest of definition, day and target, so a duplicate scheduled fire converges on the same rows (the
test pins one digest computed by the original code). Blocks already in the plan are skipped. A cached
event Moss created for the same follow-through reference links the block as already placed with no
reservation; two or more leave that target alone while others proceed. Fresh blocks are appended
(new `plans::append_blocks`, one revision bump), then only the new automatic blocks are frozen as one
batch under `day-plan-auto:<run id>` (new option on `apply::reserve` that skips pending manual
additions; it cannot be set from a request body). A revision conflict at either step returns a result
with `revisionRace` set and nothing reserved, so the run still commits. It returns `null` when the run
planned nothing. `findUnfinishedBatch` reads without writing and names the operation while any item is
pending or unknown.

Differences from the original: the ambiguous-target warning log is not emitted (the guest has no
logger); the legacy-event lookup reads cached events in pages and filters in the guest because the
query port has no JSON-path filter; a source run is checked through the existing Briefings reference
when the plan is created, as in the plan-create path.

Checks: nine guest tests in `tests/auto_plan.rs` (in-memory host) plus all earlier guest suites pass
with Rust 1.95.0; the Wasm build passes. The signed-package database gate now also runs
`auto_plan_oracle` against installed Wasm, real Postgres and row security: one block reserved, a
second linked from a real cached event, a duplicate fire converged to one batch, another account sees
nothing.

Not proven: any caller (no Briefings package), the apply job that would settle the batch, a second
account over HTTP, a second physical device. Still required: Connectors, Tasks and Briefings
adapters, apply execution, retry/recover/confirm running a change, source behavior and
external-calendar status controls, full shell and chat, old-screen replacement, complete parity.
