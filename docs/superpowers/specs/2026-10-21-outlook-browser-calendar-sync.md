# Outlook calendar into Moss through a dedicated browser

Status: proposed; awaiting Ben's approval of this concrete design.
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
`spikes/o365-firefox-preview-prototype`. No product changes or real imports have
been made under this design. The existing branch remains `moss/o365-email-talk`.

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
and covered range becomes *unconfirmed*, with an owner-visible connection
warning. Do not silently delete it or advertise its time as confidently free.
Partial scans, date navigation and authentication failure cannot generate this
transition. The first implementation must show uncertainty through the existing
Calendar/connection status surfaces; it must not leave an apparently current
meeting or free-time calculation when it knows the source needs verification.

Use the existing connection settings and Calendar surfaces. No new module or
calendar screen is proposed. The required status/remediation copy is:

| State | Owner sees | Remediation |
| --- | --- | --- |
| Collecting | Updating Outlook calendar | Wait for first complete refresh |
| Current | Last refreshed time and covered date range | Sync now |
| Partial/stale | Calendar may be incomplete; last complete refresh retained | Retry / inspect browser |
| Sign-in needed | Outlook sign-in required; calendar is not current | Open dedicated browser and sign in |
| Source changed | Outlook calendar layout or event identity unsupported | Pause; repair collector |
| Unconfirmed event | Previously seen meeting needs verification | Check occurrence in Outlook |
| Disconnected | Outlook calendar updates paused | Reconnect |

Existing events remain readable if disconnected; they carry stale source health.
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
publishing work data. No deployment or merge is included in this approval.

## Approval requested

Approve calendar-first implementation of this read-only, primary-calendar,
30-day design, with the source-quality gates above. Changes to the destination,
write capability, source coverage or processing scope require updating the
accepted design. VM provisioning and broad email ingestion are separate work.
