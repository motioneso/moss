# Native Vocci sign-in feasibility proof

Development only; part of #3565. This is not the finished setup wizard and is
never the release application. The regular companion still requires the
provisioning described in its parent README until the remaining wizard is built.

`bash apps/vocci-delivery/proof/build.sh` builds a separate
`ai.moss.vocci.setupproof` application, **Moss setup proof**. It compiles the same
`VocciAccount`, `VocciHttp` and `VocciBindings` classes intended for the setup
wizard. It has Internet and Bluetooth connect access, but no delivery service
or private-file provisioning flow. Ring access is requested explicitly only for
the selected-ring proof described below. It does not request scan access. The optional Moss-link proof screen is
described below. Installing it does not replace
`ai.moss.vocci`.

Open the proof and use the email of your existing Vocci account. **Send code**
starts native sign-in. **Verify code** completes email verification and requests
an authenticator code if TOTP is required. Other required methods are reported as
unsupported. It then uses a session token for the real read-only ring lookup and
removes the setup-created session. It never creates an account or ring binding.
No code is sent automatically at launch or after restart.

Without a staged Moss account, the sign-in proof displays only the validated ring
count and discards the binding list after lookup. A passing lookup is a phase-one
result, not completed product onboarding. Zero rings is a successful empty account
lookup; it does not prove that an owned ring can complete setup.

After verified sign-in is interrupted, **Finish ring lookup** explicitly resumes
only the saved active session after checking its native client and session identity.
It sends no new code. Other interrupted attempts require cleanup before a new sign-in.
**Cancel / clean up session** retries cleanup. Offline or unconfirmed cleanup keeps the separate
encrypted retry record. A changed native client/session is rejected. Never
uninstall or clear this test app while cleanup remains pending.

Account actions serialize across recreated screens and reload retained state
before proceeding. An older screen cannot discard a newer session using an empty
cached record. Installed synthetic lifecycle checks and their observed failing
controls are recorded in the [account recreation evidence](../../../docs/research/2026-10-21-vocci-account-recreation.md).

The separate app-private `no_backup/auth-proof-result.json` stores only the backend
acceptance flag, validated ring count, cleanup-confirmation flag, truthful client
identity and time. These fields support bounded textual evidence; they contain no
account address, ring identifiers, codes, session tokens or binding keys.

Installed synthetic contract checks:

```bash
adb -s <phone> shell am instrument -w \
  ai.moss.vocci.setupproof/ai.moss.vocci.VocciAuthChecks
```

Expected: `result=PASS`, instrumentation code `-1`. These checks use synthetic
transport responses, so they cannot pass the live vendor-acceptance gate. Real
acceptance requires the installed sign-in UI and actual backend responses, with no
network interception or developer credential injection. Remove this isolated app
after confirmed session cleanup and retain the original working companion.

While this test screen is foreground, it keeps the display on. Leaving it allows
the normal phone timeout again; it does not change system settings. Failures save
only a local error code and time in `no_backup/auth-proof-error.json`. Development
instrumentation can inspect bounded attempt flags and native client status with
`-e diagnose true`; it performs a read-only client fetch and sends no email.

## First-install Moss linking proof

The same isolated APK also contains `MossSetupProofActivity`, backed by
`SetupLink`. Launch it explicitly in a development session:

```bash
adb -s <phone> shell am start -n \
  ai.moss.vocci.setupproof/ai.moss.vocci.MossSetupProofActivity
```

Enter the Moss HTTPS origin, choose **Connect Moss in browser**, approve the phone
in Moss, return and choose **Check approval**. Account confirmation remains in a
separate encrypted staging record; no delivery configuration, ring connection,
voice enrollment or delivery service is created. For local development, only this
separate proof APK permits HTTP to loopback (`localhost`, `127.0.0.1`, `::1`),
for an ADB reverse connection to a dev instance. Other HTTP hosts remain blocked;
the production manifest and release HTTPS policy are unchanged.
**Cancel / revoke test link**
revokes the test credential and cancels its request. A network failure retains
cleanup material; retry cancellation before removing the app. A lost redemption
response requires cancellation with the original private attempt proof rather than
another redemption. The server retains that cancellation path while an issued
device references it, even after approval expiry.

The screen keeps input/views stable while requests run and announces status. It
uses the existing native theme and never places account credentials in an intent.
Browser approval receives the same origin/fragment URL as the existing companion
flow. `setup-link-proof.json` records only the result (`linked` or `cancelled`) and
time. Do not read `setup.enc` through ADB.

Installed synthetic staging checks use dedicated synthetic stores:

```bash
adb -s <phone> shell am instrument -w \
  ai.moss.vocci.setupproof/ai.moss.vocci.SetupLinkChecks
```

For the private live UI harness, `-e inspect true` returns only phase/staging/config
flags and, while approval is pending, the URL already handed to the browser. Keep
that URL out of logs. This inspection never exports the private verifier or issued
credential, and does not run or reset the synthetic stores.

This screen is development-only. The production launcher still opens the existing
companion, and its fresh install still uses developer provisioning until the full
guided ring setup is integrated. Never present this separate proof as a finished
onboarding flow.

## Selected-ring transaction proof

After Moss account confirmation, **Continue to Vocci ring lookup** opens the native
sign-in screen with a ring-selection section. Sign in explicitly, then select one
of the rings returned by the real account lookup. The temporary Vocci session is
removed before the list is offered for selection. Unselected bindings stay in
memory only; selecting a ring copies only its four validated connection fields
into encrypted setup staging and releases the inventory. Restart before selection
requires a fresh sign-in; restart after selection retains the selected candidate.
No sign-in code is sent automatically.

**Allow Nearby devices** requests Bluetooth connect permission, without scan
permission. **Open Vocci app settings** supports the existing permission handoff;
it never disables the package. Pause delivery in the working companion before a
controlled physical proof, and restore that setting afterward. The proof app does
not change the original companion's configuration, queue or preferences.

**Verify ring and save test setup** opens/closes a real `RingConnection`, verifies
physical serial/device ID and the existing key, then confirms the staged Moss
owner again before atomically saving the complete configuration. Failed proof or
account confirmation publishes no configuration. A restart before commit requires
fresh proof. Stale staging that matches the committed account and selected ring is
removed without revoking its adopted credential; a different ring requires recovery.
No delivery service, hold enrollment or Start preference is enabled. The app-private
`setup-ring-proof.json` records only configuration commitment and time.

Installed synthetic checks (dedicated stores, synthetic network and ring ports):

```bash
adb -s <phone> shell am instrument -w \
  ai.moss.vocci.setupproof/ai.moss.vocci.SetupRingChecks
```

These contracts do not prove live physical setup. Real native selection and a separate physical diagnostic passed; the complete
native Verify-and-save flow remains unverified. The
production launcher still requires developer provisioning. Do not remove the
proof app with an unconfirmed live account cleanup pending; a committed live test
configuration also needs its disposable Moss device/session cleaned up first.

For a failed live run, development instrumentation can isolate physical reachability
and existing-key acceptance using the candidate selected through this actual UI:

```bash
adb -s <phone> shell am instrument -w \
  ai.moss.vocci.setupproof/ai.moss.vocci.SetupPhysicalCheck
```

It returns only pass/fail, a bounded connection-stage code on failure, and whether
a configuration already exists. It does not confirm the Moss owner, write setup
state or publish configuration. This diagnostic is not an end-to-end setup pass.
