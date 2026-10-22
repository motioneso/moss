# Outlook calendar into Moss through a dedicated browser

Status: approved by Ben on 2026-10-21 (`approve`); implementation authorized.
Date: 2026-10-21
Tracking: [task #3567](https://github.com/motioneso/moss/issues/3567).

## Outcome and priority

Ben chose getting upcoming Outlook events into Moss before further standalone
email monitoring. A read-only calendar connection should put work meetings into
Moss's existing Calendar and make them available to existing calendar consumers
under their normal permissions. Start with the primary work calendar, from the
previous day through the next 30 days. Default refresh interval: five minutes.
Email collection remains a later slice; the prior email-send allowance does not
expand the calendar work into sending messages or creating meetings.

This is product integration, distinct from the disposable scripts under
`spikes/o365-firefox-preview-prototype`. Implementation and isolated UI proof are complete on this branch; no real
calendar import or shared-instance change has been made under this design. The existing branch remains `moss/o365-email-talk`.

## Evidence and unresolved source properties

Existing live trials established automatic single-message capture, supervised
reload/browser recovery, and displayed calendar appearance/change/disappearance.
They did not establish complete calendar coverage or authoritative cancellations.

A read-only calendar inspection for this design found:

- Fourteen displayed event elements had nonempty `data-calitemid` attributes.
- All fourteen IDs remained unchanged for the same labels after one reload.
- The time-range labels inspected included full dates and two times.
- The event detail view opened and closed without saving an event change.

Counts do not prove identity across edits, recurring occurrences, calendar
moves, or future Outlook releases. `data-calitemid` is a candidate DOM identity,
not an assumed supported Microsoft API. No real titles, IDs, addresses or event
details belong in the spec, fixtures, issue, logs or screenshots.

Before imports are enabled, validate stable identity through title/time edits,
recurring occurrences, two simultaneous events and browser restart. If the DOM
cannot distinguish occurrences reliably, stop this transport at an explicit
unsupported-source result. Do not substitute a title/start-time hash and claim
update-safe identity. This source-quality gate is part of the first build slice.

## Architecture and ownership

1. A calendar collector uses a dedicated signed-in Outlook browser profile.
   Browser ownership is bound to exactly one Moss owner and Outlook account.
   Before collection, check the visible account identity against that binding;
   mismatch pauses the connection. Never reuse one profile across owners.
2. A Moss worker orchestrates the collector for the owner's connector account.
   The initial browser endpoint is an operator-configured loopback resource,
   not an arbitrary URL supplied to a worker by an end user. Browser credentials
   are not copied into Moss connector fields or extracted by the collector.
3. The collector reads rendered UI into normalized events. It does not call
   private Outlook APIs or inspect browser authentication databases. Human
   sign-in/MFA happens in the dedicated browser; automation never fills them.
4. Connectors calls the calendar module's public import service, which validates
   events and upserts using the existing `CalendarRepository` through an
   owner-scoped `DataContextDb`. No raw SQL or cross-module internal imports.
5. Use a dedicated connector definition, `outlook-browser-calendar`, with the
   existing `calendar` provider type. Do not impersonate Google or add Google
   scopes. The existing calendar account branch in RLS is a starting point,
   not a reason to skip tests of the new account and feature-grant behavior.

Existing anchors: `packages/calendar/src/repository.ts` has account/external-ID
upserts; `packages/connectors/src/google-sync-phases.ts` shows the Google-specific
sync orchestration. Reuse the public calendar boundary, not Google's transport
or its stale-row deletion routine. Add module-owned migrations if new persistent
connection-health/observation fields are required; never edit old migrations.

The job payload contains only actor/account/resource IDs and a bounded job kind.
Event content travels directly from collection to owner-scoped storage, outside
job payloads, progress logs and diagnostic messages. The source profile and local
runtime artifacts stay outside the public checkout.

## Event contract and coverage

Required: source calendar key, source occurrence key, title, start/end, all-day
flag, source display timezone, and observation time. Preserve a source view link
only if obtained through the rendered UI. Location is optional. Attendees,
meeting bodies, attachments and mail are not needed for the first import.

- The selected Calendar must belong to the rendered My calendars group and expose
  the supported primary-only menu without secondary-calendar edit/remove actions.
  Shared and same-name secondary calendars are refused; unfamiliar menus pause
  collection as an unsupported source.
- Calendar timezone must be read/confirmed explicitly; do not assume the browser
  or host timezone matches Outlook. Reject ambiguous DST times or date ranges.
- Preserve all-day dates using the calendar module's established conventions;
  verify one-day/multi-day and DST boundaries before enabling them.
- Normalize the external ID from source calendar plus source occurrence ID.
  Upsert by account/external ID. Repeated observations update one Moss row.
- Advance through the displayed weekly views covering the explicit window.
  Require one selected source calendar, expected view dates and stable rendered
  results. Bound each scan to six weekly views, 200 events per view and 1,000
  unique occurrences. Overflow, clipping, missing fields or unsupported layouts
  produce partial coverage, not a successful empty calendar.
- A refresh is complete only after every view covering the window passes its
  checks. Checkpoints retain the last complete window and last successful time.
  A partial scan cannot advance that checkpoint or reconcile missing events.
- The browser is dedicated to collection. Trusted interaction, unexpected
  navigation, sign-in pages or account changes pause collection. Retry transient
  rendering failures with bounded backoff; do not retry MFA or access denial.

## Changes, missing events and freshness

A source ID preserved across an edit updates the existing event. A confirmed
cancellation displayed for that occurrence can mark the mirror cancelled.
Disappearance from a view alone is not confirmation of cancellation.

A previously observed event missing from two complete scans of the same source
and covered range becomes _unconfirmed_, with an owner-visible connection
warning. Do not silently delete it or advertise its time as confidently free.
Partial scans, date navigation and authentication failure cannot generate this
transition. The first implementation must show uncertainty through the existing
Calendar/connection status surfaces; it must not leave an apparently current
meeting or free-time calculation when it knows the source needs verification.

Use the existing connection settings and Calendar surfaces. No new module or
calendar screen is proposed. The required status/remediation copy is:

| State             | Owner sees                                                 | Remediation                        |
| ----------------- | ---------------------------------------------------------- | ---------------------------------- |
| Collecting        | Updating Outlook calendar                                  | Wait for first complete refresh    |
| Current           | Last refreshed time and covered date range                 | Sync now                           |
| Partial/stale     | Calendar may be incomplete; last complete refresh retained | Retry / inspect browser            |
| Sign-in needed    | Outlook sign-in required; calendar is not current          | Open dedicated browser and sign in |
| Source changed    | Outlook calendar layout or event identity unsupported      | Pause; repair collector            |
| Unconfirmed event | Previously seen meeting needs verification                 | Check occurrence in Outlook        |
| Disconnected      | Outlook calendar updates paused                            | Reconnect                          |

Existing events remain readable if disconnected; they carry stale source health.
Availability-based calendar creation also refuses stale, incomplete, disconnected,
unconfirmed or uncovered Outlook sources before any provider operation. A complete
refresh persists the source timezone for interpreting covered dates.

Disable Google-specific write/reply/RSVP/reschedule actions for this source in
both API/tools and UI. This connection grants no Outlook write capability.
Update the owning module manifests/app map for requirements, read-only behavior,
coverage, errors and remediation in the same product change.

## Delivery and acceptance

1. Prove the source contract with synthetic fixtures and bounded live inspection;
   validate event identity, timezone and full-window collection. Implement the
   collector and normalizer behind a disabled-by-default connection.
2. Wire owner-bound account setup, the public calendar import service, recurring
   refresh and health into existing Calendar/settings. Add the RLS/grant tests,
   capability guards and app-map declarations with this slice.
3. Exercise on an isolated dev instance using a reserved dev port and the proper
   verification workflow. Never use the production instance as a test target.
   Initially use invented events; a live import of Ben's calendar goes only to
   the agreed owner and instance after the source-quality checks pass.

Acceptance evidence: one occurrence creates one Moss event; repeated refresh and
restart do not duplicate it; a title/time edit updates that event; two recurring
occurrences remain distinct; all-day/DST fixtures preserve dates; partial scans
and missing rows never become cancellations; expiry/mismatch produces an honest
warning; cross-owner operations fail under RLS; unsupported source write actions
are refused. The imported event must be visible through the real Moss Calendar
UI, and freshness must survive worker/browser interruption.

Run the scoped synthetic checks, then the required product checks and isolated
DB gate using the repository's verification skill. Observe security assertions
failing when their protections are removed. Record live UI evidence without
publishing work data. The initial implementation approval excluded deployment and merge. Ben subsequently
authorized merging once ready (`let’s merge when ready`); deployment remains outside
this work.

## Approval

Ben approved calendar-first implementation of this read-only, primary-calendar,
30-day design, with the source-quality gates above. Changes to the destination,
write capability, source coverage or processing scope require updating the
accepted design. VM provisioning and broad email ingestion are separate work.

## Operator setup and verification

The connection is disabled when the optional operator binding is absent. Configure
all three values together on the API and worker processes:
`MOSS_OUTLOOK_BROWSER_ENDPOINT`, `MOSS_OUTLOOK_BROWSER_OWNER` (Moss user UUID), and
`MOSS_OUTLOOK_BROWSER_ACCOUNT` (the expected Outlook account address). Keep these
values outside the checkout. The endpoint must be a loopback HTTP CDP endpoint
with an explicit port. Use a dedicated desktop Chrome profile and one Outlook
calendar tab, English/Gregorian display, and exactly the primary Calendar selected.
The owner signs in and completes MFA manually in that browser.

The owner connects through Settings → Connections → Outlook calendar. The worker
refreshes every five minutes; Sync now requests a bounded retry. Account or layout
mismatch and sign-in failure pause automatic collection. Three incomplete attempts
also pause until a manual retry. Binding changes cannot repurpose an existing
connection: restore its original source before reconnecting. Disconnect stops
imports and retains cached commitments; closing Chrome stops its signed-in session
from being available to the collector. This slice does not provision a VM or
manage browser startup/sign-in.

The scoped database check is `test:integration:3567`. The isolated browser proof is
`test:integration:3567:ui`, with claimed ports supplied through
`MOSS_CALENDAR_UI_API_PORT` and `MOSS_CALENDAR_UI_WEB_PORT`. Launch both through
`scripts/run-gate.sh`; never point either at a shared database. The UI proof uses
invented third-party collector observations and runs real auth, Settings, queue,
owner-scoped import, API and Calendar UI. It does not prove an actual work-calendar
import into a shared Moss instance. Independent live Outlook source checks cover
rendered collection and synthetic occurrence identity separately.

## Verification record (2026-10-21)

- Live Outlook source: complete five-week scans; settled identities survived
  title/time/all-day edits, two simultaneous appointments, recurring occurrence
  and exception edits, and an actual Chrome shutdown/relaunch. Account mismatch
  and trusted human-input interruption were exercised.
- Calendar scope: 131 unit tests pass. The scoped disposable-database suite passes
  34 tests, including owner/worker RLS, grants, source binding, missing-event
  reconciliation, failure checkpoints and bounded retries.
- Real isolated Moss UI: sign in → Settings connection → queued import → repeated
  refresh without duplicates → read-only event in Calendar → sign-in warning
  retaining the checkpoint → disconnect retaining the event. API responses were
  never intercepted. Only Outlook observations were invented third-party fixtures.
- Negative controls: four independent interactive/staged delete/move tests fail
  when their source guards are removed. Owner-binding, source-fingerprint and
  feature-grant checks also fail with protections removed. The trusted-input test
  fails with its interruption flag disabled. Same-name secondary/shared-calendar
  fixtures fail with source-selection checks bypassed. Availability guard bypass
  fails both interactive/staged refusal fixtures before provider operations. All
  protections were restored.
- Synthetic Outlook appointments, the recurring series and exception were removed
  through the UI. A subsequent complete five-week scan found zero synthetic
  occurrences. The dedicated source browser was stopped and test ports released.
- Consecutive collector refreshes complete from the final week left by the prior
  refresh. The regression fails with the original navigation bound restored.
- Merge review: both independent review axes completed. Source selection and
  availability-uncertainty findings were corrected and re-reviewed; production
  bundles externalize the browser library and resolve it as a runtime dependency.
- Full typecheck, lint and formatting passed at the implementation handoff. The
  initial repository file-size check failed on unchanged `apps/web/src/chat/chat-drawer.tsx` at 1,001 lines, also present at
  the branch's starting revision. Updating from main brings its existing fix (987
  lines); no local waiver or unrelated restructuring was added. Final post-review
  gate and CI receipts are recorded on the pull request.

The implementation remains disabled without operator configuration. No work
calendar has been imported into a shared instance, and no deployment has been
performed. Ben authorized merging after readiness checks; final merge status is
recorded on the pull request.
