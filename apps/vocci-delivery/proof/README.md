# Native Vocci sign-in feasibility proof

Development only; part of #3565. This is not the finished setup wizard and is
never the release application. The regular companion still requires the
provisioning described in its parent README until the remaining wizard is built.

`bash apps/vocci-delivery/proof/build.sh` builds a separate
`ai.moss.vocci.setupproof` application, **Moss setup proof**. It compiles the same
`VocciAccount`, `VocciHttp` and `VocciBindings` classes intended for the setup
wizard. It has Internet access and no ring permissions, delivery service, Moss
account link or private-file provisioning flow. Installing it does not replace
`ai.moss.vocci`.

Open the proof and use the email of your existing Vocci account. **Send code**
starts native sign-in. **Verify code** completes email verification and requests
an authenticator code if TOTP is required. Other required methods are reported as
unsupported. It then uses a session token for the real read-only ring lookup and
removes the setup-created session. It never creates an account or ring binding.
No code is sent automatically at launch or after restart.

The proof displays only the validated ring count. It discards the binding list
after lookup and does not physically connect a ring. A passing lookup is a phase-one
result, not completed product onboarding. Zero rings is a successful empty account
lookup; it does not prove that an owned ring can complete setup.

**Cancel / clean up session** retries cleanup. An interrupted attempt must be
cleaned up before a new sign-in. Offline or unconfirmed cleanup keeps the separate
encrypted retry record. A changed native client/session is rejected. Never
uninstall or clear this test app while cleanup remains pending.

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
