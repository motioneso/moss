# Vocci native sign-in proof: phase-one evidence

Part of #3565 / draft PR #3566. Ben approved the existing-owner setup design on
2026-10-21. **Status: native owner sign-in, real binding-backend acceptance and temporary
session cleanup passed on the installed proof.** The remainder of the wizard is
not built.

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
| Installed synthetic native contracts                   | `contracts=39`, `result=PASS`, instrumentation `-1`                                 | Fixtures do not prove owner/backend acceptance         |
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
protections were restored; final installed baseline passed all 29 contracts at that checkpoint.

The final installed proof APK SHA-256 is recorded below with the live retry.

Private local logs retain build output, the installed assertion summaries and
control results. Public evidence includes no account email, device address,
serial, account token, code or ring key. A bounded app-private result record can
prove real binding acceptance and cleanup after the owner completes the real UI.

## Gate result and remaining work

The owner completed native email-code sign-in in the installed proof. After a
local token-response parser correction, the explicit **Finish ring lookup** UI
resumed that same verified session. The actual binding backend accepted the
truthful client identity and returned one validated owned ring. The proof removed
its temporary session and confirmed cleanup. The executable UI showed the passed
result and re-enabled **Send code**; the safe result record agreed:

```json
{
  "bindingBackendAccepted": true,
  "ownedRingCount": 1,
  "cleanupConfirmed": true,
  "clientIdentity": "MossRingCompanion/1.0 (Android native setup)",
  "time": "2026-10-21T22:01:11.969259Z"
}
```

This clears the native-auth feasibility gate. No developer credential injection,
network interception or browser-token extraction was used. Required TOTP was
covered by contracts; the live account did not request it.

Do not close #3565, merge this product PR or describe initial setup as finished.
The remaining staging/linking, selection, physical proof, polished wizard, app map,
recovery, upgrade and delivery proofs must still be implemented and verified.

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
The corrected build was installed before the second owner attempt. This was
a local client bug, not a vendor-policy rejection. No email was sent by the failed
attempt, and no user session or ring binding was created/changed.

The separate proof now records only a safe local error code/time on failure and
uses clearer error messages. It keeps the screen on while foreground for the
interactive test; system timeout settings were not changed. The bounded read-only
diagnostic is development-only and reports field-presence booleans/statuses, never
account addresses, tokens, full identifiers or binding details.

## Second owner attempt: token response correction

The owner successfully verified the email code and created a temporary native
session. The next request failed locally: the adapter expected a `response`
wrapper on every Clerk response, but the session-token endpoint returns a direct
`{ "object": "token", "jwt": "..." }` resource. An in-app diagnostic observed HTTP
200 and only these structural facts; it did not expose the JWT or raw body.
The temporary token-shape diagnostic was removed afterward; the retained
`diagnose` option still only fetches the native client.

Changing the synthetic token fixture to the actual direct-resource shape first
reproduced the exact installed failure: `result=FAIL`,
`check=auth_response_invalid`, instrumentation code `1`. The adapter now uses the
direct resource only for the exact session-token route and validates its resource
type and JWT. Other routes still require their existing response envelope.

The proof adds explicit **Finish ring lookup** recovery after verified sign-in.
It fetches the pinned native client and requires exactly the saved active session
before resuming. Missing verification state, a changed client, another session,
multiple sessions or an expired session cannot resume lookup. The successful live
retry used this UI without sending another email. Removing the saved-session
identity comparison produced `guard_missing_auth_cleanup_conflict` in the installed
contracts; the guard was restored. Final baseline: 39 contracts passed.

After confirming remote cleanup and the absence of the separate encrypted attempt
record, the isolated proof app was uninstalled. The working companion remains in place.

Final proof APK SHA-256: `17cc16d786d0514cb1f4ebcd198e2dacd3d5c194cd586493fe7cd3c09237c249`.
