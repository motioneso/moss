# Vocci Android: initial setup for an already-owned ring

Task: #3565. Follows merged #3554. **Status: proposed; awaiting design approval.**

## Outcome and scope

A fresh companion install can connect Moss, sign into the owner's existing Vocci
account, select an already-owned ring, verify it, and start delivery without ADB,
bootstrap JSON or copied tokens. An existing configured install keeps working
without repeating setup. Normal recordings remain Meetings; opted-in hold-to-talk
remains Main chat with text replies.

The first slice supports existing ownership on the verified legacy protocol.
Factory-fresh ownership provisioning, ownership transfer, firmware updates,
streaming and ring-space reclamation are separate work. Setup never resets a ring,
deletes recordings, registers a new binding or disables the official package.

## Authentication decision and feasibility gate

Use the existing browser-approved Moss link. For Vocci, propose native email-code
sign-in to the same existing account, then read-only binding retrieval. This is a
different sign-in from Moss; explain why it is needed before sending a code.

[Authentication findings](../../research/2026-10-21-vocci-initial-setup-auth.md)
record the evidence and rejected alternatives. Current public configuration
enables native API and email codes. Clerk's hosted browser callback needs vendor
package registration that has not been established for Moss. Do not embed/scrape
the official login page, transfer browser cookies, copy browser JWTs, impersonate
the official package, or present its callback as ours.

**Before building the remainder of the wizard**, prove native sign-in and the
binding GET with a legitimate owner session on an isolated installed app. Honor
required TOTP MFA using the documented native flow; an unknown or unsupported
factor stays blocked with an actionable explanation. No password reset, sign-up
or factor bypass. An account requiring an unsupported method is outside this
slice and must be named in the guide, not represented as successfully connected.

Keep this adapter separate from ring protocol and Moss authentication. Use the
published native authentication contract; choose the minimal direct client or
official SDK after tracing credential handling and proving actual compatibility.
Do not turn callback registration or anti-bot rejection into an undocumented
workaround. If native/backend acceptance fails, stop that approach and bring back
the evidence and supported alternative before broadening scope.

## Screens and behavior

Extend the current Android companion. Use `NativeTheme`'s Archivo headings,
paper/forest semantic roles, numbered ruled sections and accessible native
controls. No new Moss module or chat destination.

### Empty install

```text
MOSS / RING COMPANION
Set up your ring
Connect an existing Vocci ring to Moss.

01  Moss account
Moss address  [https://your-moss-server]
[Connect Moss in browser]
Approval waiting / Account connected: <account>
[Check approval]  [Cancel]

02  Vocci account
Use the account that already owns your ring.
Vocci sends a sign-in code to your email.
Email  [                         ]
[Send code]
Code   [      ]
[Verify]  [Resend code]  [Use another email]
Required authenticator code, when requested  [      ]

03  Your ring
Rings on your Vocci account
( ) Ring <serial suffix>    [Select]
Turn on Bluetooth, keep the ring nearby, and finish the handoff below.
[Verify ring]

04  Ready to connect
Bluetooth / notifications / battery status
[Open permission settings]
Vocci Nearby devices handoff, if needed
[Open Vocci app settings]
Meetings: completed recordings are processed in Moss
Hold-to-talk in Main chat  [Off]
[Start delivery]
```

Reveal each step after its prerequisite succeeds; retain completed steps and
provide Back/Cancel. The account ring list is not a nearby-device scan: label it
accordingly. Select by account-provided identity, then test physical reachability
and authenticated identity. Do not add scan permission solely to populate this
list. Request Bluetooth connect access and complete official-app handoff before
physical verification; step 03 links directly to the same settings in step 04.

Do not send email automatically on opening the screen. Resend is explicit,
respects server throttling and shows a cooldown. Invalid/expired codes keep the
email and offer a retry; process death starts a fresh sign-in attempt rather than
resending a code in the background. Never echo a code in status text.

### Existing install and completion

An existing valid configuration opens the current companion screen. Setup shows
its Moss account/ring as connected; it does not re-fetch the key on each launch
or reconnect. Reconnect Moss uses the same approved-browser flow and owner pin.
This slice does not add a switch to another owner, origin or ring.

After first-run verification, show the account and selected ring for confirmation.
Start uses the existing delivery service and explicit recovery preference. Setup
alone does not enable delivery or hold-to-talk. New hold opt-in uses the existing
stable-inventory/backlog exclusion and review/Send rules. Opening setup on an
existing install preserves its current choice; it does not silently stop or start
delivery.

### Empty, waiting and error states

| State                                                 | User sees and can do                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Moss address invalid / unavailable                    | Inline address error or Retry; no credential sent to a changed origin                                       |
| Browser approval pending / denied / expired           | Waiting, declined or expired status; Check, Cancel or start a new request                                   |
| No existing Vocci account or no rings                 | Explain that ownership must first be established in Vocci; Retry or change email; no automatic registration |
| Binding malformed / duplicate / missing key           | Ring cannot be verified; retry account lookup; no guessing or exposing key data                             |
| Required MFA unsupported                              | Explain the required sign-in method is not supported yet; preserve previous configuration                   |
| Bluetooth off / permission denied / ring unavailable  | Explain the actual prerequisite; open settings or retry verification                                        |
| Official app still has Nearby devices access          | Open its settings with instructions to relinquish access; do not disable the package                        |
| Different physical serial/device ID or proof rejected | Reject the candidate; keep the existing setup and pending recordings                                        |
| Network loss / rate limit                             | Retry with bounded waits; no automatic duplicate code sends or user-visible success before confirmation     |
| Cancel / restart                                      | Keep committed setup and queued audio; discard or resume encrypted staging according to the lifecycle below |

Keep text fields, keyboard focus, scroll and entered email stable during background
status checks. Use labels and announced status/error text, at least 48 dp targets,
and reachable controls in light/dark themes at normal and 150% font scale.

## State and integration boundaries

The current `MossLink` reads `config.enc` before starting approval. Add a distinct
staged setup record so an empty install can link Moss before possessing ring
configuration. Do not make a half-filled delivery config look runnable.

The staged record owns the chosen Moss origin, approval attempt/proof, confirmed
owner/device credential and candidate ring until completion. Use `SecretStore`
with a separate Keystore alias/file. Before redemption, preserve the existing
ten-minute browser-approval lifecycle. Cancelling a pending attempt uses its
existing cancel endpoint; cancelling after redemption revokes the setup-created
Moss device credential. If offline, retain only the encrypted cleanup material
needed to retry revocation, and do not report remote revocation as completed.

Keep Vocci authentication attempts separate from Moss credentials. The proposed
adapter must use fixed official HTTPS destinations, reject credential-bearing
redirects, bound responses/timeouts and map errors to safe local codes. Do not
send Vocci tokens or binding responses to Moss, logs, intents, saved UI state,
analytics or public evidence. Trace actual client/library storage and request
handling before asserting those properties as implemented.

Use a temporary Vocci session for setup. Release code fields and in-memory token
references after lookup; keep only any encrypted staging necessary to finish
verification or clean up the setup-created session. Revoke that session through
the documented API when possible, without touching other sessions. Network failure
must not cause silent loss of retryable revocation material. Do not promise JVM
string erasure or that sign-out succeeded offline.

Fetch existing bindings with the owner's authenticated GET, not register/bind/
unbind endpoints. Normalize the selected connection MAC; validate nonempty,
bounded serial/device ID/key; reject ambiguous matches. Do not guess `bindStatus`
semantics or equate the backend consumer ID with a Clerk subject without evidence.
Only the selected binding proceeds to encrypted staging; release unselected keys.

Reuse the existing identity query and key proof in `RingConnection`. Verify serial
and firmware device ID, then authenticate using its existing canonical connection
MAC handling. A successful cloud lookup alone is not ring verification. Setup
does not send recording-control, deletion or sync-completion commands.

Commit the complete validated configuration atomically only after confirming the
Moss owner and ring proof. Existing `SecretStore.assertSameIdentity` remains the
boundary on replacement. Upgrade, cancel and repair preserve `DeliveryStore`'s
`sourceDeviceId`, frozen evidence, dedup identities, voice enrollment and all
pending/failed/interrupted audio. A corrupt existing configuration is a recovery
error, not permission to silently adopt another account or ring. Reconcile
completed configuration and stale staging after process death before revoking a
credential that is now the active one.

All feedback comes from actual setup records, API results and ring observations.
No model decides sign-in success, device identity or setup completion. The model
has no job in this flow; existing downstream audio processing stays unchanged.

Implementation must update the Android guide and the owning Meetings/core app-map
declarations, including setup prerequisites, unsupported ownership cases and
remediations. No new server auth bypass or ordinary-chat access for Android.

## Acceptance and limits on completion claims

1. **Feasibility first:** installed native email-code sign-in (and required MFA)
   yields a session accepted by the real binding GET, without manual token export.
   Confirm the actual client identity is accepted. Configuration flags and SDK
   fixtures alone do not pass this gate.
2. **Fresh app, existing owned ring:** real setup UI → browser-approved Moss →
   native Vocci sign-in → ring selection/proof → explicit Start → physical normal
   recording → visible processed Meeting. Opted-in hold → Main/text reply. An
   isolated proof package is allowed if disclosed and it preserves the original
   installed companion and binding; its callback/registration differences must be
   recorded. No private-file injection is proof of product setup.
3. **Recovery:** cancel at each step, restart before/after redemption and atomic
   commit, lost responses, code resend/rate limit, wrong/expired code, MFA, empty/
   ambiguous binding list, wrong key/identity, Bluetooth denial, competing official
   app and offline revocation. Observe intended failures with relevant protections
   removed before claiming account/credential/identity isolation.
4. **Upgrade:** existing configured install starts without Vocci sign-in, preserves
   source identity and pending audio, and retains working linking/recovery/voice
   behavior. No new ring recording required merely to exercise a UI retry state.
5. **Quality:** meaningful host/device tests, APK build and required repository
   checks; DB tests only through `verify-gate`; final CI plus installed executable
   UI assertions. Retain bounded text evidence and actual tested commit inputs.

Do not call task #3565 complete or merge a product PR until the live-path evidence
is recorded. If vendor policy prevents a supported flow, report that specific
blocker and revise the design rather than presenting a partial bootstrap screen
as finished initial setup.
