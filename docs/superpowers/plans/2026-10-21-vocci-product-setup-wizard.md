# Vocci product setup wizard

Part of #3565 / draft PR #3566. Implements the approved
[initial setup spec](../specs/2026-10-21-vocci-initial-ring-setup.md).

## Verified seams

- `apps/vocci-delivery/src/ai/moss/vocci/SetupLink.java:39`: encrypted first-install
  transaction; status, browser approval, selection and fresh ring/owner commit.
- `apps/vocci-delivery/src/ai/moss/vocci/VocciAccount.java:53`: explicit native
  email-code sign-in, resumable lookup and retryable temporary-session cleanup.
- `apps/vocci-delivery/src/ai/moss/vocci/NativeTheme.java:17`: native semantic
  colours, Archivo headings, accessible controls and ruled sections.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryActivity.java:140`: existing
  explicit Start, permission status, recovery preference and hold opt-in.
- `apps/vocci-delivery/AndroidManifest.xml:11`: production launcher and service.
- `apps/vocci-delivery/proof/build.sh:19`: isolated installed app can include
  production setup UI without changing the original companion.

Real native sign-in, binding lookup, session cleanup and selected-ring commit are
observed; see [transaction evidence](../../research/2026-10-21-vocci-ring-transaction-proof.md).
The combined automation run remains red. Existing installed companion data must
remain untouched while checking the new empty-install screen.

## Bounded slice

1. Add a production `SetupActivity` over the existing transaction. Keep labeled
   fields and sections mounted; background actions update record-derived state.
   No automatic email sends or saved code fields. Email-code, TOTP, resumed lookup,
   explicit resend/cooldown and retryable cleanup use the same production adapter.
2. Empty launcher routes into setup; existing configuration keeps the delivery
   screen. Corrupt/orphaned state shows recovery instead of adopting a new owner.
3. Reveal Moss approval, account inventory, explicit ring selection, Nearby and
   official-app handoff, then native Verify. Only after committed setup offer the
   existing companion screen, whose Start and hold opt-in remain explicit.
   This slice does not start delivery from setup or introduce a second consent
   journal. Final ready-screen Start/hold integration is a subsequent bounded
   slice, using the existing service actions after their wiring is checked.
4. Include this exact production setup activity in the isolated proof manifest.
   Build sequentially; check empty launcher, prerequisites, stable fields,
   process recreation and permission/handoff return without new email sign-in.
5. Update guide and app map to distinguish implemented setup UI from remaining
   live acceptance. Keep task open and PR draft.

## Verification and stop conditions

All feedback comes from setup records, platform permissions and actual requests;
no model decides account identity or success. Setup has no model job. Existing
Meeting/chat processing is unchanged.

Run `apps/vocci-delivery/test.sh` and `apps/vocci-delivery/proof/build.sh`
sequentially, expected exit 0. Require installed instrumentation `result=PASS`
and code `-1`, not ADB exit alone. Record actual native UI checks in both themes
and normal/150% font scale. No private-file injection substitutes for real setup.
Final browser/recording acceptance uses `scripts/run-gate.sh` per verify-gate;
no direct database tests or piped verification commands.

Kill gate: if the production UI cannot reuse the existing transaction without
weakening owner/ring guards or touching pending recordings, stop this slice and
record the conflict before broadening the service boundary. Agent owns this
check; Ben decides any scope expansion. No merge/deploy is authorized here.
