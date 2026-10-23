# Vocci account cleanup across recreated screens

Part of #3565 / draft PR #3566. This fixes a demonstrated account-controller
lifecycle bug before integrating the product setup wizard.

## Reproduction and change

An empty `VocciAccount` controller can outlive its activity while another
controller completes sign-in. Previously the older controller's `cleanup()`
noticed the newer encrypted file, but read its own empty cached record. It
deleted that file without making any session-removal requests, losing the
details needed to clean up the newly created temporary session.

The installed regression constructs both real controllers over the same
dedicated synthetic `SecretStore`, completes verification through the newer
controller and then cancels through the older one. Before the fix it failed at
`recreated_cleanup_confirms_current_session_removal`: all three expected cleanup
requests remained unconsumed. This was synthetic session state; no vendor
session was created by this regression.

The account controller now serializes operations across instances and reloads
the encrypted record before each action. A changed record moves an older
controller to cleanup/recovery rather than reusing its old code-entry step.
After another controller removes the attempt, the old connected controller
cannot request a binding token. The constructor also participates in the same
serialization boundary. UI status getters do not acquire the network lock.

## Installed checks

The native-auth suite passed 42 contracts after the change; the staged-link and
ring-transaction suites also passed 27 and 28 contracts (97 total). The new checks cover
the stale empty controller, rejecting lookup after another controller cleans up,
and cancellation overlapping an in-flight verification. The overlap test blocks
the verification response with latches and requires cleanup to wait; afterward
it confirms the expected removal requests and absence of the synthetic record.

Removing only cleanup's transaction lock made the installed suite fail at
`cleanup_waits_for_inflight_verification`. The source was restored and rebuilt;
all 42 contracts passed again with instrumentation code `-1`.

These checks ran in an isolated development package,
`ai.moss.vocci.contractproof`, repackaged from the proof APK with the same
production account classes and synthetic instrumentation. This kept the separate
live setup proof and working companion untouched while the phone was locked.
Instrumentation success requires `result=PASS` and code `-1`; ADB's own exit code
alone does not indicate test success.

Tested source SHA-256 values:

- `VocciAccount.java`: `59f1d680035eef24984b534e876af7417f6369348d2c5cbe1ad7a880bb4eae10`
- `VocciAuthChecks.java`: `a306bdb6ff4bb6c888e0be56261b0ef5f227b0dfcf4bc878620a2b5b98c18b4b`
- Installed sibling APK: `9a492040eeeb3a0b87993e535029112cd83fb192eec8b00922425b1b2623505d`

This evidence does not complete native physical Verify-and-save acceptance,
the integrated wizard, or the final foundation/CI gates. The PR remains draft.
