# Vocci setup in the selected settings style

Task #3584; preserves remaining #3565 acceptance. Approved direction:
`../specs/2026-10-23-android-hardware-settings.md` Concept A and the approved
initial-setup spec. Scope follows the merged setup-style continuation handoff.

## Existing seams

- `apps/vocci-delivery/src/ai/moss/vocci/NativeTheme.java:19` owns native
  paper/forest, Archivo and native controls; `SettingsRow.java:12` owns flat links.
- `SetupActivity.java:46` builds the persistent wizard controls; `:222` renders
  saved phases and `:275` reads delivery choices without starting them.
- `HardwareActivity.java:37` routes an empty install to setup; `:185` renders the
  flat Hardware/ring list. Its explicit switch actions own Start/Stop.
- `DeliveryActivity.java:133` renders diagnostic snapshots and account recovery.
  `SetupActivity.java:148` currently sends setup completion directly here.
- `packages/shared/src/app-map-core.ts:107` describes the native Hardware surface.

These capabilities exist in the current tree, inspected after graph discovery.
No new server, store, protocol or dashboard is required.

## Decision and files

Use the existing native views and settings navigation. Retain the fresh setup's
staged prerequisite behavior; replace numbered duplicate headings and long IT copy
with compact ruled sections. A committed setup shows saved account/ring identity
and current delivery/hold choices rather than disabled sign-in forms. Completion
opens Hardware settings; diagnostics remain explicitly available there. Add a
visible Back action. Keep status/error feedback from the existing actual records.

Modify NativeTheme, SetupActivity, HardwareActivity and DeliveryActivity in place;
SettingsRow only if the native focus treatment needs it. Update the Android README
and core app map with the actual navigation. No production files are deleted.
A private executable UI observer and public bounded evidence accompany the change.

The alternative of a new embedded mobile shell would reproduce existing navigation
and require another account/browser seam. Keep the approved native settings scope.
The model has no job here: all feedback, progress and choices are deterministic
record/API/permission state, with no host chat injection.

## Verification and kill gate

1. `apps/vocci-delivery/test.sh` must exit 0 (host suites and APK build).
2. Scoped app-map tests, ESLint/Prettier, file-size and full typecheck must exit 0.
   Run design token/UI class checks if web styling changes. No DB-touching test or
   foundation gate runs without verify-gate. Preserve command exit codes; do not
   pipe verification commands.
3. Installed real UI assertions: fresh empty setup under a disclosed disposable
   identity sends no email/approval or Start on opening; hidden future controls,
   Back navigation and stable entered address. On the authorized physical phone,
   verify saved setup/Hardware/diagnostic traversal, system dark mode, 150% font,
   reachable controls and unchanged account/ring/source, queue/exclusions and
   enabled/hold/cleanup choices. No new enrollment, recording or ring writes.
   Never clear or rebind production to make a fresh setup state.
4. A signed production update needs fresh phone availability, installed APK and
   certificate comparison, exact source verification and version above 20261026.
   Preserve the known automatic replacement failure separately; any explicit
   manual recovery after replacement is recorded as such. No blind repeat install.
5. Pin immutable base/head for independent Standards and Spec review. Resolve and
   independently re-review findings. Real UI proof and green required CI precede
   authorized merge, then the verified fresh isolated successor carries the queue.

Kill gate, owned by vocci-setup-style: stop rollout if signature/identity/source
preflight fails or saved setup/choices change on UI opening. Retain the failed
receipt and investigate; do not reset/rebind or claim acceptance. If phone unlock
is unavailable, continue host/source review and record the exact external blocker;
do not merge unverified UI.

Private state and receipts: `~/.local/state/moss/vocci-recovery/setup-style/`.
