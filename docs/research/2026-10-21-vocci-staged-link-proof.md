# Vocci staged Moss linking: phase 2a evidence

Part of #3565 / draft PR #3566. This follows the successful
[native owner sign-in proof](2026-10-21-vocci-native-auth-proof.md) and implements
[the staged-link plan](../superpowers/plans/2026-10-21-vocci-staged-moss-link.md).
The production launcher still requires developer provisioning; the integrated
ring setup wizard is unfinished.

## Transaction boundary

`SetupLink` saves first-install Moss approval and account confirmation in a
separate `SecretStore` record. It does not construct delivery state, connect a
ring or start delivery. Approval, redemption, owner confirmation and cleanup
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

The first disposable-instance run exercised native Connect, fresh Moss owner
signup/onboarding, explicit Android browser approval, native account confirmation
and native Cancel. Safe native evidence reported cancellation confirmed, with
staging and delivery configuration absent. The final browser assertion timed out;
that run is not a complete live-path pass. A later attempt stopped before linking
because the phone was locked. Final installed UI verification remains pending.

No recording or Vocci email code was needed for this Moss-link check. It used the
canonical recording-live runner's throwaway database, API, worker and fresh owner;
no shared account or database was used. Browser logs contain bounded structural
assertions, not passwords, approval URLs, verifiers or device credentials.

The remaining approved work is selected-ring staging, the integrated native
wizard, permissions and official-app handoff, physical identity/key verification,
atomic configuration commit, and explicit Start with a fresh delivery proof.
Full foundation, CI and the complete first-run live path remain required before
#3565 can be considered finished. Keep the PR draft.
