# Vocci staged Moss linking: phase 2a evidence

Part of #3565 / draft PR #3566. This follows the successful
[native owner sign-in proof](2026-10-21-vocci-native-auth-proof.md) and implements
[the staged-link plan](../superpowers/plans/2026-10-21-vocci-staged-moss-link.md).
The production launcher still requires developer provisioning; the integrated
ring setup wizard is unfinished.

## Transaction boundary

`SetupLink` saves first-install Moss approval and account confirmation in a
separate `SecretStore` record. Its account-link entry points do not construct
delivery state, connect a ring or start delivery. Selected-ring commit is covered
separately in [phase 2b](2026-10-21-vocci-ring-transaction-proof.md). Approval, redemption, owner confirmation and cleanup
have separate durable states. A lost redemption response requires cancellation;
an unconfirmed logout retains cleanup material. Recreated controllers serialize
transactions and reload staging rather than using a stale in-memory record.

A valid committed configuration matching the staged origin, owner and credential
adopts that credential. Reconciliation removes only staging. A different or
malformed configuration, or delivery state without configuration, blocks new
linking and requires recovery.

The isolated proof APK includes a native Connect / Check / Cancel screen using
`NativeTheme`, stable text fields, announced status and 48 dp buttons. Its separate
package does not replace the working companion. Only the proof package permits
HTTP to loopback for an ADB reverse connection; production HTTPS policy is unchanged.

## Observed regression controls

- Expired-attempt cleanup originally deleted the only cancellation proof after a
  lost redemption response. The real database regression failed with the issued
  credential still accepted after cancellation. Retaining referenced attempts
  restored the expected HTTP 401.
- A single conditional DELETE still failed when cleanup overlapped redemption:
  its statement snapshot missed the just-committed device. A test-only advisory
  lock pauses the real device insert while another actual pairing request runs.
  Gate `20261021-153319` failed exactly at the expected credential rejection.
  Cleanup now locks expired candidates with `FOR UPDATE SKIP LOCKED`, then checks
  device references in a second statement in the same transaction. Gate
  `20261021-153417` passed all 27 pairing integration tests.
- Explicit cancellation had the same overlap problem: it could inspect devices
  before redemption committed, then delete the attempt afterward. Gate
  `20261021-153642` failed with the credential still valid. Cancellation now locks
  the verifier-authorized attempt before inspecting devices. Final focused gate
  `20261021-153804` passed all 28 pairing integration tests.
- An installed stale-controller contract failed at
  `recreated_controller_reads_latest_staging`; refreshing staging under the
  process-wide transaction lock restored it.
- Removing offline cleanup retention failed at
  `offline_cleanup_material_retained`. Revoking an adopted credential failed at
  `committed_credential_preserved`. Removing committed-config validation failed
  at `guard_missing_setup_recovery_required`. All guards were restored.

Final installed staging contracts: 27 passed. Native sign-in contracts: 39 passed.
Host protocol/crypto/transfer/WAV checks passed, including the generated two-hour
writer case. This does not add a two-hour hardware test.

## Live UI check

Final canonical live gate `20261021-154755` exited 0 on commit
`8687ca80b706670b4d342a5357c17adfd52d98e8`, clean inputs fingerprint
`264e3e2948a4`. Installed proof APK SHA-256:
`37196da654d47f89ecb2e2b10eb8a2e833f427cc48fdf9acba5dcb547fd65b29`.

Executable native/browser assertions passed for Connect, fresh disposable owner
signup/onboarding, explicit Android approval, native Check account confirmation,
process restart retaining the staged account, and native Cancel. A fresh Settings
tab in the same real signed-in browser context confirmed that Active sessions no
longer listed the issued Android device. Native inspection confirmed both staging
and delivery configuration absent. The original companion package was untouched.
Owned browser, ADB reverse, isolated proof activity and gate container were cleaned
up. Earlier runs reached cancellation but timed out reloading the browser's
existing Settings tab; those runs are not claimed as complete passes.
No recording or Vocci email code was needed for this Moss-link check. It used the
canonical recording-live runner's throwaway database, API, worker and fresh owner;
no shared account or database was used. Browser logs contain bounded structural
assertions, not passwords, approval URLs, verifiers or device credentials.

The remaining approved work is selected-ring staging, the integrated native
wizard, permissions and official-app handoff, physical identity/key verification,
atomic configuration commit, and explicit Start with a fresh delivery proof.
Full foundation, CI and the complete first-run live path remain required before
#3565 can be considered finished. Keep the PR draft.
