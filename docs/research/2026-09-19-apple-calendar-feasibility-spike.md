# Apple Calendar protocol and authentication feasibility spike

**Issue:** #2010 (child of #1003)

**Research date / source access date:** 2026-09-19

**Scope:** First-party Apple material only; documentation research, not implementation

## Recommendation: Deferred

Apple now explicitly documents that supported third-party apps can access iCloud Calendar after the
user authorizes the app with their Apple Account, with an app-specific password as a fallback.
Apple also documents CalDAV as a calendar account/source type on its platforms. However, the public
Apple material reviewed does **not** publish an iCloud Calendar server endpoint, service discovery
procedure, server-side app enrollment process, Calendar scopes, token contract, or CalDAV sync and
error contract that Moss can implement against.

That is not sufficient evidence for a stable, Apple-supported server-side connector. Per the
approved spike rule, #1003 should remain deferred and no Calendar implementation children should be
created. Reopen the decision if Apple publishes an iCloud Calendar developer contract for
server-side apps or gives Moss documented access to the supported authorization program and its
endpoint/protocol requirements.

## Evidence classification

| Question                                               | Finding                                                                                                                                                                                                                                                                                                                                                           | Classification                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Does Apple support third-party iCloud Calendar access? | Yes, for “supported third-party apps”: Apple says users can authorize such an app with their Apple Account to access iCloud Mail, Calendar, and Contacts. Apple does not define “supported,” app eligibility, or server-side enrollment on that page.                                                                                                             | **Documented** user-facing support; server-side developer path **unknown**                                                |
| Is CalDAV supported?                                   | Apple documents generic CalDAV account configuration in Device Management and describes an EventKit source as “a CalDAV or iCloud source.” Neither document identifies the iCloud service endpoint or makes the generic client/device APIs an iCloud server API contract.                                                                                         | **Documented** as an Apple-platform client/source type; iCloud server use **not established**                             |
| What iCloud endpoint/discovery flow should Moss use?   | No first-party Apple source reviewed publishes an iCloud Calendar hostname, well-known discovery URL, principal URL, or redirect/discovery contract. The generic CalDAV configuration schema requires the operator to supply a server address and optionally a principal URL.                                                                                     | **Unknown**; any endpoint taken from a third-party implementation would be **inferred/reverse-engineered**                |
| What authentication is supported?                      | Apple documents Apple Account authorization for supported apps. If an app does not support that flow, Apple documents an app-specific password fallback; generating one requires two-factor authentication.                                                                                                                                                       | **Documented**, but its binding to a server-side CalDAV client is **unknown**                                             |
| Is this OAuth?                                         | Apple’s user support page does not name OAuth, publish authorization/token endpoints, define scopes, or link to developer onboarding. Apple’s separate “Account & Organizational Data Sharing” OAuth documentation says it covers Apple REST services such as Roster API; it does not identify iCloud Calendar.                                                   | iCloud Calendar OAuth **not documented**; treating the separate framework as Calendar authorization would be **inferred** |
| Can a connector list events and calendars?             | Apple’s iCloud guide documents one or more calendars, viewing multiple calendars, and cloud synchronization across configured devices. It does not document server request/response shapes for listing them.                                                                                                                                                      | Product behavior **documented**; connector behavior **unknown**                                                           |
| Can it refresh incrementally?                          | Apple says changes automatically appear across configured devices, but publishes no iCloud Calendar sync-token, ETag, cursor, push, polling, or resync contract in the reviewed material.                                                                                                                                                                         | User-visible synchronization **documented**; incremental server refresh **unknown**                                       |
| Can it reconcile deletion/cancellation?                | Apple says adding, deleting, and updating events automatically appears on configured devices. No public iCloud Calendar contract reviewed defines deleted-event tombstones, cancellation semantics, recurrence exceptions, retention, or full-resync recovery.                                                                                                    | Cross-device deletion propagation **documented**; connector reconciliation **unknown**                                    |
| Are multiple calendars supported?                      | Apple documents creating and managing one or more calendars and viewing multiple calendars. It also publishes account limits that include calendars.                                                                                                                                                                                                              | **Documented** product capability; server enumeration semantics **unknown**                                               |
| What happens on revoke?                                | Removing Apple Account authorization makes the app unable to access the data until the user authorizes it again. Revoking an app-specific password signs the app out until the user creates a new password and signs in again; changing/resetting the primary password revokes all app-specific passwords. Apple does not publish the HTTP/CalDAV error returned. | Access loss and recovery **documented**; wire error **unknown**                                                           |
| Was behavior observed?                                 | No authorized dedicated test account was available, so no account login, authorization, endpoint probe, or revocation test was performed.                                                                                                                                                                                                                         | **Not observed**                                                                                                          |

## Authentication and revocation details

### Apple Account authorization

Apple’s support article instructs the user to enter their Apple Account email address in a
supported third-party app, choose **Allow** when prompted, and return to the app. The same article
places revocation under `account.apple.com` → **Sign-In and Security** → **Account Data Sharing** →
**Remove access**. After removal, the app cannot access the user’s data until authorization is
repeated.

The article does not document:

- how a developer becomes a supported app;
- whether a headless/server-side web service is eligible;
- authorization or token endpoints, scopes, redirect requirements, credentials, or refresh rules;
- whether Mail, Calendar, and Contacts are one bundled grant or independently scoped;
- the protocol or endpoints used after authorization; or
- the error response and retry/recovery signal after revocation.

### App-specific password fallback

Apple says app-specific passwords let third-party apps access iCloud information including mail,
contacts, and calendars without collecting the primary Apple Account password. The account must
have two-factor authentication enabled. Apple allows at most 25 active app-specific passwords and
lets the user revoke one or all of them. Revocation signs out the app; changing or resetting the
primary account password automatically revokes every app-specific password.

Apple does not document an iCloud Calendar endpoint or the HTTP authentication mechanism to pair
with this password. It also does not document Calendar-only scope. A server integration would
therefore retain a reusable account credential with access boundaries that the reviewed Apple
material does not make granular.

## Protocol and synchronization assessment

Apple’s Device Management `CalDAV` schema is evidence that Apple operating systems support
configuring CalDAV accounts. It requires `CalDAVHostName`, supports `CalDAVPrincipalURL`, username,
password, port, and SSL (default `true`), and warns that passwords belong only in encrypted
profiles. The example uses `server.example.com`; it does not name iCloud. This is a device
configuration schema, not documentation of Apple’s iCloud Calendar service.

Likewise, EventKit provides on-device access to the user’s calendar database, including sources,
multiple calendars, event listing, change notifications, and deletion after local user permission.
That path requires an Apple-platform app running with EventKit authorization and does not provide a
server-side API suitable for Moss.

The iCloud user guide confirms the product semantics Moss ultimately needs: multiple calendars
exist, and adding, deleting, or updating an event appears across configured devices. It does not
define the network contract needed to implement those semantics. In particular, the reviewed
first-party sources do not specify:

- an iCloud CalDAV base URL or standards-based discovery entry point;
- collection/principal discovery and redirect stability;
- calendar/event identifiers and recurrence or cancellation mapping;
- initial sync, incremental sync, tombstones, or forced full-resync behavior;
- conditional requests, paging, push notifications, or polling cadence;
- authentication, revocation, throttling, or transient-error status codes; or
- compatibility/support commitments for a non-Apple server process.

## Published limits and operational constraints

Apple publishes these iCloud Calendar/Reminders account limits:

- 50,000 total calendars, events, and reminders;
- 100 calendars and reminder lists combined;
- 1 GB total calendar and reminder data, including attachments;
- 20 MB per calendar event including attachments;
- 20 attachments per event;
- 300 attendees per event; and
- 100 people per privately shared calendar.

These are content/account ceilings, not API quotas. No first-party request-rate limit, retry policy,
backoff rule, concurrency cap, or service-level objective for iCloud Calendar integrations was found
in the reviewed material.

The US iCloud Terms and Conditions add material product constraints:

- use must comply with the agreement, law, and generally accepted practice;
- exceeding applicable or reasonable bandwidth or storage limits is prohibited, and Apple may
  suspend access when use threatens the service or its systems;
- availability varies by country/language, the service may change, and uninterrupted or error-free
  service is not guaranteed;
- users are responsible for maintaining an alternate backup of important content; and
- a covered entity, business associate, or representative may not use iCloud to create, receive,
  maintain, or transmit protected health information or make Apple its business associate.

The PHI restriction is a product boundary, not merely an implementation detail, if Moss would ever
process healthcare calendar content in a regulated role. Legal review would still be required
before shipping; this technical spike does not interpret the agreement beyond recording its text.

## Security implications for a future reconsideration

- Prefer Apple Account authorization over an app-specific password if Apple documents and approves
  a server-side route, because Apple presents authorization as the supported-app path and it avoids
  giving the connector a reusable password.
- Treat any app-specific password as a secret: never expose it to the frontend, logs, prompts,
  screenshots, job payloads, or exports, and encrypt it at rest. Apple’s generic CalDAV profile
  guidance similarly says passwords belong only in encrypted profiles.
- Fail closed after authorization/password revocation and require explicit reauthorization. Do not
  silently fall back to the primary Apple Account password.
- Do not infer Calendar-only least privilege. The current Apple support copy groups Mail, Calendar,
  and Contacts, and does not publish scopes.

These are constraints for a newly scoped design only; this spike does not authorize implementation.

## Bounded technical check

Not performed. No dedicated test account with explicit authorization was available. Consistent
with the approved spec, this research did not access an Apple Account, credentials, cookies, a
browser session, or any undocumented endpoint. Consequently there are no observed endpoint,
response, error, or revoke results to report.

## First-party sources

All sources were accessed 2026-09-19.

1. Apple Support, [**“Access your iCloud Mail, Calendar, and Contacts in third-party apps”**](https://support.apple.com/en-us/121539)
2. Apple Support, [**“Sign in to apps with your Apple Account using app-specific passwords”**](https://support.apple.com/en-us/102654)
3. Apple Developer Documentation, [**“CalDAV”**](https://developer.apple.com/documentation/devicemanagement/caldav) (Device Management configuration profile)
4. Apple Developer Documentation, [**“EKSourceType.calDAV”**](https://developer.apple.com/documentation/eventkit/eksourcetype/caldav)
5. Apple Developer Documentation, [**“Accessing Calendar using EventKit and EventKitUI”**](https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui)
6. Apple Developer Documentation, [**“Account & Organizational Data Sharing”**](https://developer.apple.com/documentation/accountorganizationaldatasharing)
7. iCloud User Guide, [**“Keep your calendars up to date and share them with iCloud”**](https://support.apple.com/guide/icloud/what-you-can-do-with-icloud-and-calendar-mm15eb200ab4/icloud)
8. iCloud User Guide, [**“Create and edit a calendar on iCloud.com”**](https://support.apple.com/guide/icloud/create-and-edit-a-calendar-mmfbbb2cf9/icloud)
9. Apple Support, [**“Limits for iCloud Contacts, Calendars, Reminders, Bookmarks, and Maps”**](https://support.apple.com/en-us/103188)
10. Apple Legal, [**“iCloud Terms and Conditions”**](https://www.apple.com/legal/internet-services/icloud/us-en/terms.html) (United States)

## Research limitations

Apple’s public Support and Developer documentation were searched for iCloud Calendar, CalDAV,
third-party authorization, Account Data Sharing, discovery, and endpoint material. Absence from
those results is not proof that Apple has no private partner contract or allowlisted integration.
It does establish that Moss cannot rely on a public first-party server contract today. No
third-party implementation was used as evidence, and no reverse-engineered hostname or flow is
reported as supported.
