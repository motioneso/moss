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
