# Apple Calendar Protocol and Authentication Feasibility Spike

**Status:** Approved for feasibility spike; implementation deferred pending decision

**Date:** 2026-08-26

**Owner:** Ben

**GitHub:** #1003 (parent); #2010 (feasibility-spike child)

**Security tier:** Security

## Purpose

#1003 originally combined iCloud Mail and Calendar delivery. iCloud Mail is already available
through the generic IMAP connector, so this issue now owns only the question: can Moss provide
iCloud Calendar access through a stable, Apple-supported protocol and authentication flow?

This is a one-session research and decision task. It does not authorize connector implementation.

## Scope

The spike must establish, using current first-party Apple material and a bounded technical check when
necessary:

1. Whether Apple officially supports third-party server-side access to iCloud Calendar.
2. Whether CalDAV is a supported integration path, and the current discovery/endpoint requirements.
3. The supported authentication method: app-specific password, Apple Account authorization, OAuth, or
   another documented mechanism.
4. Whether authentication and endpoint behavior support read-only event listing, incremental refresh,
   cancellation/deletion reconciliation, and multiple calendars.
5. The behavior of revoking an app-specific password or Apple authorization, including the expected
   error and recovery path.
6. Any Apple terms, account prerequisites, rate limits, or operational constraints that change the
   product decision.

The output must cite the exact Apple URLs, document titles, and access dates used as evidence. If
Apple's public material does not define a stable endpoint or API contract, say so explicitly rather
than presenting reverse-engineered behavior as officially supported.

## Technical evidence to record

The researcher may use a dedicated test account only if Ben supplies or authorizes it. Do not put
credentials in the repository, issue comments, logs, prompts, job payloads, screenshots, or this
spec. A manual probe must be read-only, bounded, and discarded after the check.

Record only sanitized facts:

- protocol and endpoint/discovery behavior;
- authentication method and required account settings;
- event and calendar capability limits;
- bounded response/error categories;
- revocation behavior;
- whether the behavior is documented by Apple, observed experimentally, or inferred from a
  third-party implementation.

## Decision output

The child issue closes with exactly one recommendation:

- **Supported:** Apple documents the path sufficiently; create separately scoped implementation
  issues.
- **Conditional:** the path works but Apple documentation or support boundaries are incomplete; Ben
  explicitly accepts an experimental integration before any implementation issues are created.
- **Deferred:** no stable, officially supported path is established; close or leave #1003 deferred
  with no Calendar implementation children.

The default recommendation is **Deferred** when the only evidence is an undocumented CalDAV endpoint
or a reverse-engineered authentication flow.

## Explicit non-goals

- No CalDAV/CardDAV client, provider enum, database migration, secret shape, sync worker, or UI.
- No generic arbitrary-host calendar connector.
- No webmail scraping, browser automation, cookie reuse, or access-control workaround.
- No production-account connection or write-back/calendar mutation.
- No implementation children before the decision above is recorded and accepted.

## Follow-up decomposition if supported

Only after a Supported or explicitly accepted Conditional decision, split the work into separate
session-sized issues for:

1. Apple Calendar connection, validation, encrypted secret lifecycle, and revoke.
2. CalDAV read adapter and provider-neutral event mapping.
3. Scheduled sync, reconciliation, health/freshness, and calendar feature grants.
4. Connected-account UI, setup/recovery copy, and focused integration/live-path evidence.

Each child must have one primary write set and fit approximately one agent session.

## Acceptance checklist

- [ ] Current first-party Apple sources are cited with title, URL, and access date.
- [ ] Protocol/API and authentication support are classified as documented, observed, or inferred.
- [ ] Read/sync/revoke requirements are answered or marked unknown.
- [ ] Security and terms constraints are recorded.
- [ ] A Supported, Conditional, or Deferred recommendation is explicit.
- [ ] No implementation child is created without a Supported or explicitly accepted Conditional
      decision.
