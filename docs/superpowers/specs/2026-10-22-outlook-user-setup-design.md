# Outlook calendar: per-user setup and browser separation

**Status: user flow and disconnect semantics approved by Ben on 2026-10-22.**
Proceed with the isolated synthetic runtime proof, then finalize the implementation spec and
build task. Runtime choices below are requirements to validate, not claims about protections
that exist today. This approval does not authorize deployment or production migration.

Tracking: [task #3570](https://github.com/motioneso/moss/issues/3570).

## Problem and outcome

The current calendar connector uses one operator-configured browser endpoint, Moss owner, and
expected Outlook address for an installation. Its routes and worker use that binding. This
supports the first calendar but gives other Moss users no self-service setup.

Each signed-in Moss user should be able to connect their own Outlook primary calendar through
Settings → Connections. A new Moss installation starts with no Outlook account, saved session,
or imported events. Two users on one installation must be able to connect independently.

The user should only need to select Connect Outlook, complete normal Microsoft sign-in and MFA,
and confirm the account Moss detects. No per-user environment variables, application registration,
CDP endpoint, or browser-profile path should be part of that flow. An installation without the
optional browser runtime must explain what its operator needs to enable.

This approach does not bypass tenant restrictions. Managed-device requirements or unusual-sign-in
checks can still prevent a connection. Do not promise that automation will be invisible to Microsoft
or an employer. Do not retry failed sign-in automatically or try to work around a policy denial.

## Reviewable screens

Build and open the [offline interactive mockup](../mockups/outlook-user-setup/README.md).
All accounts in it are fictional. The review selector simulates external changes; it is not part
of the product. This fixture proves neither Microsoft compatibility nor account isolation.

| State                      | Screen and action                                                                  | Transition requirement                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Not connected              | Explain read-only scope; Connect Outlook                                           | Create an owner-bound setup attempt                                                  |
| Preparing browser          | Progress, Cancel setup                                                             | Allocate a new browser; cancellation schedules cleanup                               |
| Microsoft sign-in          | Open sign-in window; waiting status; Cancel setup                                  | Human completes Microsoft pages; Moss detects identity                               |
| Confirm account            | Detected address; Connect this calendar; Use a different account                   | Explicit confirmation before import; different account starts from a cleared profile |
| First sync                 | Waiting status; safe to leave Settings; Disconnect                                 | Complete first authoritative scan before showing current                             |
| Up to date                 | Account, primary calendar, event count, last check, coverage; Sync now; Disconnect | Continue automatic checks                                                            |
| Sign-in expired            | Sync paused; last imported events retained; Sign in again                          | Resume only after original account is verified                                       |
| Different account detected | Expected and detected address; sync paused                                         | No silent source replacement; original account or disconnect                         |
| Sign-in blocked            | Explain organization requirements; reopen window or cancel                         | Human resolves Microsoft requirement; no automated credential retries                |
| Browser unavailable        | Retry; operator remediation                                                        | Preserve events and last successful checkpoint                                       |
| Calendar unreadable        | Retry; failed scan cannot remove events                                            | No authoritative deletion from incomplete or unreadable views                        |
| Disconnect confirmation    | Explain local event and saved-session removal; Keep connected                      | Explicit destructive confirmation                                                    |
| Removing session           | Sync stopped; cleanup progress                                                     | Prevent replacement setup until old runtime is removed                               |
| Session removal failed     | Sync stopped; retry cleanup                                                        | Never label the saved session removed before cleanup succeeds                        |

Preserve the existing calendar freshness, coverage, and uncertain-event treatment. An unsuccessful
scan cannot advance last-successful time. No success state inferred from an empty or missing DOM.
The existing Calendar continues showing Outlook events as read-only with source attribution.

## Proposed ownership and source binding

- One active Outlook primary-calendar connection per Moss user initially. A source account is
  immutable after confirmation; replacing it means disconnecting and creating a new generation.
- The server derives the owner from authentication. Client-supplied owner, account address,
  runtime endpoint, profile path, and generation are never authority.
- The runtime needs separate browser processes and persistent storage for every connection.
  Incognito contexts inside a shared browser are insufficient for this design. An implementation
  must also establish a container/OS boundary that prevents one browser reading another profile;
  different profile directories alone do not establish that property.
- Use opaque connection/runtime IDs, not addresses or user-controlled filesystem names. Keep
  the owner, confirmed address, source fingerprint, and connection generation in owner-scoped
  connector data. Keep endpoint and storage references behind the runtime interface.
- Verify the rendered Outlook account before confirmation and before every scan. Ambiguous,
  missing, or changed identity pauses collection. An email alias is not silently accepted as an
  account change; any normalization rule must be explicit and tested.
- Reconnecting requires the originally confirmed account. The confirm-account screen must not
  turn a reconnect into a source-replacement operation.
- Two Moss users may independently sign into the same Outlook account if Microsoft permits it;
  they still get separate browser sessions and independently owned imported copies.
- Existing RLS and explicit grant rules apply. Setup does not create sharing grants. Admin status
  must not grant access to another user's address, calendar, browser screen, or browser controls.

## Sign-in runtime: implementation proof required

No general-purpose private browser provisioning/sign-in service was identified in the current
connector. `packages/auth/src/session-bindings.ts` is a possible auth-session building block;
the admin terminal and sports renderer are not substitutes for a private user sign-in window.

Proposed seam: a managed-browser broker owns allocation, screen/input transport, persistent
storage, termination, and cleanup. The app and worker ask for operations on server-resolved
connection IDs. The collector retains its rendered-calendar logic; neither the browser viewer
nor the general web client receives CDP access. The broker must not accept arbitrary destinations
or expose a public browser/debugging port.

Before finalizing the build spec, use an isolated runtime spike with fictional/local pages to
select and demonstrate a deployment adapter. Prefer one isolated container per connection, with
separate storage and a narrowly authenticated broker outside the app. Do not mount a host container
control socket into the Moss API or worker. Choosing an actual container engine, broker privilege
model, protocol/library, persistent-volume protection, and package/deployment support is still
open engineering work. This document does not assert an uninspected vendor stack is safe.

The spike must demonstrate:

1. Local and remote/headless installations show a usable Microsoft browser window through an
   authenticated Moss route. Desktop and phone controls need a practical sign-in path; never
   embed Microsoft pages as a cross-origin iframe or ask Moss to collect a password in its own form.
2. Pixel output and keyboard/pointer input are bound to the current live Moss auth session and
   connection owner. Validate Origin, upgrade authentication, CSRF and session revocation; no bearer
   credentials in URLs or browser storage. Authentication alone is insufficient without ownership.
3. A second Moss user, an admin, an expired session and a replaced connection generation cannot
   obtain frames, send input, resume a stream, or invoke collector/debug operations. Check the
   receiving library's actual behavior and test with the protection deliberately disabled.
4. During interactive sign-in, collection is locked out. One controller at a time; other tabs
   show an in-use state. Closing the viewer detaches input without terminating the saved browser.
   Sign-out/revocation closes streams promptly. A bounded idle timeout ends interactive control.
5. Password entry, cookies, frames, clipboard contents and page bodies are excluded from access
   logs, recordings, diagnostics, AI prompts, exported data and job payloads. Inspect actual data
   paths before claiming that. Disable downloads, clipboard sharing, file transfer and recording.
6. Restart restores only the correct connection's profile. Cleanup terminates the process,
   revokes viewer/collector access and removes persistent data; partial cleanup is retryable.
7. Fresh-install packaging ships empty runtime storage and requires no per-person operator setup.
   Installing, updating, backing up and uninstalling the optional runtime have documented paths.
   Profiles contain live authentication material: document volume access, backup exclusions and
   at-rest protection honestly rather than assuming Chrome profile files are encrypted secrets.

No real accounts are needed for the isolation spike. A later real Microsoft sign-in requires a
human to complete normal sign-in and should be tested on a dedicated dev instance, never production.
If the adapter cannot meet these constraints, revise this design before feature implementation.

## Collection, cancellation and lifecycle

Retain read-only primary-calendar collection from yesterday through the next 30 days, normally
every five minutes. Enumerate active owner-scoped connections instead of a single env binding.
Jobs carry IDs and generation only; resolve runtime access at execution. Enforce owner/connection
locks across scheduler, manual refresh, sign-in and disconnect. Recheck active generation and
permissions after the scan and before committing data. A late scan from a cancelled/replaced
connection cannot reinsert events or update the new connection's checkpoint.

Cancellation before confirmation imports nothing and removes the setup profile. Abandoned setup
attempts expire and are cleaned up automatically. The final spec must choose explicit setup,
viewer-idle, lease and cleanup-retry timeouts after the runtime spike; do not ship unbounded attempts.

Disconnect stops further imports immediately and removes imported events for that connection,
then deletes the local saved browser session. This differs from temporary sign-in expiry, which
retains events as stale. Retry cleanup after failures/restarts and block replacement until done.
Deleting a Moss account must invoke the same cleanup without needing the user to sign in again.
Local cleanup does not claim to revoke Microsoft sessions on other devices.

## Compatibility and delivery boundaries

Keep the existing operator binding working while the new runtime is absent. Do not copy its
profile or bind it to another user. The legacy owner sees the current connection status; other
users can use self-service only when the managed runtime is enabled. Explicit migration to a
managed profile requires a new sign-in and atomic replacement under the same owner. Never run
legacy and managed collectors concurrently for that owner. Migration failures preserve the old
working binding and checkpoint. No production migration or restart is authorized by this draft.

Any runtime/config requirement must ship with the applicable dev, installer and production
deployment support in the implementation PR. The core app must remain usable without Outlook.
Every new route, connection state, error and remediation needs matching app-map metadata in that
same product PR. This docs-only review changes no app-map declarations or application behavior.

Excluded: email ingestion, Outlook writes, multiple calendars per user, cross-user browser sharing,
Graph permissions, arbitrary user-provided browser endpoints and automated MFA completion.

## Acceptance evidence required before shipping

- Two ordinary users connect different synthetic sources concurrently; UI, API, jobs, database
  context and runtime traces agree on ownership. Attempts to substitute IDs fail at every boundary.
- Repeat with an admin, no auth, expired/revoked session, stolen viewer identifier, and stale
  generation. Each security test must fail when its corresponding protection is removed.
- Observe sign-in → confirmation → first import → background refresh through a live dev UI with
  executable assertions and bounded DOM/network evidence. No screenshot substitutes for live proof.
- Account mismatch, unreadable view, runtime crash/restart, disconnect during a scan, abandoned
  setup, cleanup failure and user deletion have explicit observed outcomes. No stale job repopulates
  events, no partial scan removes events, and no checkpoint advances on failure.
- Build/install the distributable in an empty environment: no profile, account, address, event,
  private binding or credential from a developer installation is present. Sign-in for its first
  user starts from a clean profile. Repeat with two different installations.
- Keep the legacy path working in isolated regression fixtures. Never exercise deletion or
  migration against the existing production connection as a test.

## Approval and next artifact

Ben approved the user flow and disconnect semantics against the mockups on 2026-10-22. Finalize
a tracked implementation spec after the runtime proof resolves deployment and transport choices.
The runtime spike and feature build need task tracking and the repository's normal gates.
This approval covers the design and isolated proof; deployment and production migration remain
outside this design's scope.
