# Vocci initial setup: authentication options

Task: #3565. Date: 2026-10-21. Status: discovery, not product acceptance.

## Finding

Recovering an existing owner's ring binding is established. Automatically returning
an official browser login to the Moss Android package is not established. The next
candidate is Clerk's native existing-account email-code flow, followed by the
existing read-only binding lookup. An installed owner-device test must establish
that this combination works before completing the setup wizard.

## Evidence and limits

| Evidence                                                            | Observation                                                                                                                                          | Limit                                                                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved Vocci 1.1.24 build 333 analysis, Hermes function 47960        | Existing bindings come from authenticated `GET /device/app/bind-list`; no ring registration request is needed                                        | Static evidence does not establish a third-party login callback                                                                                          |
| Saved 2026-10-19 owner validation                                   | An official `accounts.vocci.ai` Clerk session token was accepted by that GET; its existing key authenticated independent ring sessions               | The diagnostic flow obtained the token manually; it was not consumer onboarding and was not repeated today                                               |
| Current public `clerk.vocci.ai/v1/environment` response, 2026-10-21 | Native API enabled, `email_code` enabled as an email first factor, production/non-test environment; TOTP and backup-code factors are also advertised | Public configuration does not prove this particular account can complete native sign-in or that the resulting session is accepted by the binding backend |
| Clerk Android authentication reference                              | Native email-code sign-in and required second-factor completion are documented                                                                       | No account-specific authentication attempted during discovery                                                                                            |
| Clerk hosted-authentication guide                                   | Production callbacks require the app's package registration in the vendor's Clerk dashboard                                                          | Moss cannot assume `ai.moss.vocci` is registered; this is not a shipping browser-return plan                                                             |
| Current companion source                                            | `MossLink.begin()` loads complete ring configuration before browser pairing; `SecretStore.provision()` consumes a developer bootstrap                | Reusing browser approval on an empty install needs a staged account state                                                                                |

The saved binding endpoint is
`https://durer.proactiva.ai/api/device/app/bind-list`. Its observed request used
`Authorization: Bearer <account token>`. The saved Python recovery initially got
Cloudflare 403/1010 with Python's default User-Agent, then succeeded with the app
HTTP client's `okhttp/4.12.0` header. That historical result is not a recommendation
to spoof a browser or bypass a new service restriction. A production client must
identify itself truthfully and establish backend acceptance on its actual stack;
an incompatible policy is a blocker to resolve, not a reason to rotate identities.

The binding response can be a raw array or a successful `{code,data,success}`
envelope. Relevant fields are `deviceId`, `sn`, `macAddress`, `consumerId`,
`bindStatus` and `bindKey`. Numeric `bindStatus` meanings were not established.
Selection must reject missing keys, malformed identities and ambiguous matches;
it must then verify the physical ring using the existing authenticated handshake.
Do not infer ownership from a device name or Bluetooth address alone.

The ring identity response's MAC byte order differed from the connection address
in prior hardware validation. Existing `RingConnection` checks serial/device ID
and uses the canonical connection MAC for the proof. Preserve that behavior.

## Options

1. **Native existing-account email code — proposed first slice.** Enter the email
   used for Vocci, send and verify a code, satisfy any supported required MFA, and
   fetch the existing bindings. This uses no embedded login page or browser-token
   extraction. Native API/backend acceptance remains an explicit feasibility gate.
2. **Official browser login and native return — defer.** This would preserve
   familiar social sign-in, but the documented callback setup requires vendor
   registration. There is no verified Moss registration or supported transfer
   contract. Never impersonate the official Android package or its callback.
3. **Retained configuration — preserve.** Already-configured owners continue
   using their working key. This avoids repeat sign-in but cannot onboard an empty
   install, so it is an upgrade path rather than a replacement setup flow.

No account creation, password reset, session export, local official-app database
extraction, ring reset, cloud registration, unbinding or ownership transfer belongs
to the proposed existing-owner flow. Failure of native sign-in must remain visible;
it must not silently fall back to any of those operations.

## Source references

- [Clerk Android quickstart](https://clerk.com/docs/android/getting-started/quickstart)
- [Clerk native authentication](https://clerk.com/docs/android/reference/native-mobile/auth)
- [Clerk hosted authentication](https://clerk.com/docs/android/guides/account-portal/hosted-auth)
- Existing companion: `apps/vocci-delivery/src/ai/moss/vocci/{MossLink,SecretStore,RingConnection}.java`.
- Saved artifact: Vocci 1.1.24 build 333 APK SHA-256
  `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.
  REA class inventory `ev_f76f0648667df6624eebfde468974d37e9597bccae09732a6705b69575f9600b`
  confirms the native `OdinClerk` bridge; it is class inventory, not executed login
  or complete library token-handling proof.

Public configuration response SHA-256:
`dff892f99a5df24c4a353109c7ed703a3da2887a9627eea036f82406262eb236`.
The response and bounded capability summary are retained in private task evidence.
No account token, email address, ring key or device identifier is included here.
