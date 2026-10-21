# Vocci native sign-in proof: phase-one evidence

Part of #3565 / draft PR #3566. Ben approved the existing-owner setup design on
2026-10-21. **Status: adapter and isolated proof built; real owner sign-in and
binding-backend acceptance pending.** The remainder of the wizard is not built.

## Implemented experiment

`VocciAccount` handles email-code sign-in, required supported TOTP, session-token
minting, read-only binding lookup and temporary-session removal. It retains native
cleanup material in a separate `SecretStore` record. Native client identity is
pinned; restart begins with cleanup, without sending email. The selected approach
is a direct native client using the official API contract, not a browser callback.

`VocciHttp` uses fixed HTTPS destinations, bounded timeouts/response reads, disabled
redirect following, safe error-code mapping and the truthful client identity
`MossRingCompanion/1.0 (Android native setup)`. Device-token rotation is saved before
reading the response body. The session JWT used on the binding GET is separate from
the native client token. No sign-up, reset, ring binding writes or all-session
logout endpoints are included.

`VocciBindings` accepts raw arrays or successful envelopes, validates required
identities/keys and rejects ambiguous identities. The proof only uses the count;
it does not select or physically verify a ring.

The development-only **Moss setup proof** package is separate from the installed
working companion. Its manifest grants Internet only and contains no ring service,
receiver or Bluetooth permission. The production launcher/manifest is unchanged.
The proof sources live outside the production source glob. The working companion
package's last-update timestamp was unchanged after installing the proof.

## Observed checks

| Check                                                  | Observed result                                                                     | Limit                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Existing host crypto, transfer/protocol and WAV tests  | Pass; includes generated two-hour file                                              | No new two-hour hardware test                          |
| Development APK and isolated proof APK build/signature | Pass                                                                                | Development signing only                               |
| Installed synthetic native contracts                   | `contracts=29`, `result=PASS`, instrumentation `-1`                                 | Fixtures do not prove owner/backend acceptance         |
| Real native initialization on the Samsung              | HTTP 200, `nativeInitialization=PASS`; native token returned, empty sessions        | Anonymous client only; no email sent                   |
| Manifest isolation assertions                          | Separate package; Internet only; no service/receiver; production manifest unchanged | Installed product upgrade remains later work           |
| Scoped Markdown, shell syntax and diff checks          | Pass                                                                                | Full repository gate/CI follows product implementation |

Guard-removal controls were built and installed separately, each producing a
failing assertion before restoring the guard:

| Removed protection                               | Observed failure                           |
| ------------------------------------------------ | ------------------------------------------ |
| Duplicate ring-identity rejection                | `guard_missing_binding_identity_ambiguous` |
| Save rotated native token before body processing | `rotated_token_persisted_before_lost_body` |
| Pin native client identity during cleanup        | `guard_missing_auth_client_changed`        |

The client-identity control initially failed on the fixture's request queue rather
than its intended assertion. The fixture was corrected to allow the hypothetical
confirmation request; rerunning produced the missing-guard assertion above. All
protections were restored; final installed baseline passed all 29 contracts.

The final installed proof APK SHA-256 is:
`822dcb4877c84bd544e9ec4503fc9f8f61321ebe08da36f0a935b7d69dccd3c9`.

Private local logs retain build output, the installed assertion summaries and
control results. Public evidence includes no account email, device address,
serial, account token, code or ring key. A bounded app-private result record can
prove real binding acceptance and cleanup after the owner completes the real UI.

## Remaining gate

The owner must sign into the installed proof through its real email-code UI,
satisfy required supported MFA, obtain actual binding-backend acceptance using
this client identity, and confirm removal of the setup-created session. No private
file injection, browser-token extraction or replayed network response can pass
this gate. A service-policy rejection stops this approach for a supported
integration decision.

Do not close #3565, merge this product PR or describe initial setup as finished.
Only after acceptance should the remaining staging/linking, selection, physical
ring proof, polished wizard, app map, recovery, upgrade and delivery proofs proceed.

## First owner attempt: local validation correction

The first real **Send code** action created a legitimate native sign-in, then the
client rejected its identifier before preparing/sending email. The UI showed an
unhelpful generic failure. A read-only installed diagnostic confirmed the pinned
client still matched, zero sessions existed, and its sign-in needed first-factor
verification with email code available. The real identifier uses `sia_`; the
initial adapter/fixtures incorrectly assumed `signin_`.

The fixtures were changed to the observed real format first. Installed checks
then failed with `auth_response_invalid`, reproducing the production path. After
correcting the validator and route allowlist, all 29 installed checks passed.
The corrected build is installed; the real owner retry is still pending. This was
a local client bug, not a vendor-policy rejection. No email was sent by the failed
attempt, and no user session or ring binding was created/changed.

The separate proof now records only a safe local error code/time on failure and
uses clearer error messages. It keeps the screen on while foreground for the
interactive test; system timeout settings were not changed. The bounded read-only
diagnostic is development-only and reports field-presence booleans/statuses, never
account addresses, tokens, full identifiers or binding details.
