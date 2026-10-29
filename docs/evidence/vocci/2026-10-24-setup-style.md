# Vocci setup in Hardware settings

Task #3584; #3565 remains open. Base
`fb490398ffae65f4bf38b930a060debec1f4b492`. Plan `ff28556f5` preceded product
implementation. Product head `de6e4d36e852ad843188c7f739cb29a41c8dce7d`.

## Presentation and review

Fresh setup uses concise staged account/ring sections in the approved Concept A
paper/forest, Archivo and hairline system. Saved setup shows a Ring connection
summary and retained delivery/hold choices. Completion returns to Hardware;
diagnostics have an explicit Hardware destination. Existing setup, approval,
permissions and source identity still use the existing stores and actions.
The core app map and Android guide describe the resulting navigation.

Independent code-review axes reviewed the immutable base/product head above:

- Standards: zero remaining findings. The primary-button keyboard focus contrast
  finding was resolved and independently re-reviewed.
- Spec: zero remaining findings. Explicit Start stays available for recovery when
  delivery is enabled but its service is absent. Diagnostic Hardware navigation
  opens that destination even on direct task entry. Both findings were resolved
  and independently re-reviewed.

These source verdicts do not substitute for installed verification or required CI.

## Host checks

`apps/vocci-delivery/test.sh` exited 0: protocol, transfer/retry, telemetry, reminder,
PCM and recovery-parser suites plus the development APK build. Seven parser tests
passed. Three focused app-map suites passed 23 tests. Scoped ESLint/format and
file-size checks passed. Full `pnpm typecheck` passed, including test, web and
external-module TypeScript. Private command logs remain in
`~/.local/state/moss/vocci-recovery/setup-style/`. Required CI is recorded on PR #3635.

## Installed disposable UI

`python3 <private-root>/ui_check_resumed.py`: exit 0; 24 assertions including
cleanup. Actual unchanged production UI sources were built under the separate
`ai.moss.vocci.upgradeproof` identity; APK SHA-256
`66e5e23a5c1014ccf288a6c9790d5e7baa02fbdc80d464f4cd6db559d95083a6`.
Fresh setup and a generated local saved identity were exercised through actual
native activities on the authorized physical phone, without intercepted network
responses, browser approval, email-code requests or ring operations.

The checks observed:

- Fresh launcher opens setup; later code/Start controls are hidden until relevant.
  An entered Moss address survives dark-mode and 150% font recreation. Connect
  remains reachable. Opening setup creates no committed config or delivery service.
- Fresh Back exits setup. A prior observer incorrectly selected the last task in
  `dumpsys activity top`; its failed receipt remains. The corrected observer retains
  `dumpsys activity activities` and checks the actual top resumed activity.
- Generated saved setup hides completed sign-in forms, exposes explicit Start and
  the separate hold choice, reaches Connection & permissions, and returns through
  the ring and Hardware paths. Direct diagnostic entry also returns to Hardware.
- Configuration, queue and enrollment file hashes match before/after navigation;
  no delivery service started. The owned disposable package was removed and its
  absence asserted. Original system night mode and font scale were restored.

This is fresh/generated local presentation proof, not real account approval,
pairing, ring access, upload, ASR or production hold acceptance.

## Production verification

`python3 <private-root>/production_ui_validated.py`: exit 0; 63 assertions.
Production was updated once from `20261026` to `20261027` using the same signing
certificate and retained app UID. All 34 production Java source digests matched
the reviewed product head; candidate APK SHA-256
`f8c4c0c6934b35945f39037515855d9cb98ded585073f21893bd23c354ac2919`.
The release manifest disables debugging and cleartext and contains no
instrumentation. Fresh preflight compared the actual saved native state with the
baseline and verified physical phone identity, availability, unlock and timeout.

Through the real installed existing-account UI, the check traversed Hardware →
Vocci ring → Connection & permissions → Ring setup, observed the saved Ring
connection summary with completed sign-in forms hidden, and reached explicit
Start. It exercised Connection/back navigation, dark mode and 150% font, completion
to Hardware, and direct-entry diagnostics returning to Hardware. Before/after
native identity hash, enabled choice, hold off, cleanup off and three visible queue
entries compared equal. No production setup or credentials were regenerated.

The service was live before replacement, absent after replacement before UI, and
still absent after opening setup and traversing settings. Only the explicit native
Start action restored a matching live foreground service. That manual recovery is
recorded separately; opening UI neither started delivery nor changed its saved
choice. This observer did not assert exact replacement-broadcast dispatch, and
supplies no new automatic replacement acceptance.

`python3 <private-root>/final_invariants.py`: exit 0; ten read-only assertions.
Version `20261027`, native equality, matching live foreground PID, Bluetooth ON,
timeout `120000`, original night/font settings, official-app CONNECT/SCAN revocation
and disposable-package absence were verified after restoration. Private raw UI,
service, broadcast, package and native receipts remain in `production-ui-3/` and
the private root. No screenshot was used for the live-path gate.

Failed observer/preflight receipts remain unchanged: the first preflight lacked
Java on PATH; the second expected hexadecimal manifest booleans where this aapt2
prints `false`. Both stopped before any install. The corrected manifest observer
passed the actual release and rejected debug, cleartext and instrumentation
variants before installation. The first final invariant check passed its other
nine assertions but treated `pm path`'s absent-package exit 1 as a command failure;
the corrected read-only package-list check passed. None of these failures is
reported as a successful run.

No new recording, reset/rebind, production clear-data/uninstall, source deletion,
hold enrollment, firmware or server deployment belongs to this slice. The original
replacement SKIPPED/no-service failure and later explicit manual recovery remain
separate from the predecessor's successful physical reboot. Adapter/out-of-range
and interrupted-upload acceptance remain incomplete. Both task issues stay open.
