# Rust server/app slice 18: explicit server/module assembly checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-170 / Card 566. Category: N/A.

## What this checkpoint changes

The real HTTPS server can opt into the existing extended module application with a private
`--modules` configuration. It opens an existing approved catalog, reuses its lifecycle and
actor boundaries, and owns one blocking worker which advances schedules through
`Installer::run_job`. Its authenticated module API dispatches at most four blocking calls
at once, preserving guest HTTP status/body envelopes. Worker startup checks the existing
queue's worker role; an idle or failed pass waits one second, and the owner requests shutdown
and joins its current pass when the server returns. Existing launches without module
configuration keep working.

Extended-host `notify.post` now writes into `app.notifications` in the invocation's existing
transaction, with the authenticated actor as both sender and recipient and the installed
module identity. Failure rolls the notification back with the invocation. The desktop feed
and durable accepted-alert path use those same rows; acceptance still does not mark bell
items read. The older non-extended services retain their module-local notification files.
Moss's app map describes the explicit assembly and its qualification limits.

The bridge respects the actor's module notification mute preference. Quiet-hours authority
and deferral, notification body, urgency, event identity, links and deduplication are not
ported. Real reminder producers must remain disabled until these policies are implemented
and qualified; the present bridge is only a synthetic assembly checkpoint.

## Deployment and proof boundary

This is a partial checkpoint on slice 17's first remaining item. The app and installer do
not generate or pass the optional configuration yet. The catalog, module lifecycle and
Phase 2b queue schemas must already exist, and approved packages must already be installed.
The serving process does not create those schemas or duplicate the Phase 1 installer.
Module AI and embeddings remain unavailable in this assembly until their account-configured
services are connected. No third-party dependency or certificate verifier was introduced;
the shell now links the existing module-host crate and its declared dependency closure.

The executable proof uses a synthetic signed Wasm component in disposable migrated data.
It exercises the actual HTTPS executable, owner signup, module installation, an overdue
schedule executed by the server's own worker, notification delivery into the real desktop
HTTP feed, authenticated guest dispatch, receipt acceptance and unchanged bell reads. A
trapping guest exercises transactional rollback, and a muted module produces no feed row. This proves the assembly boundary, not a
real Tasks/Calendar reminder producer, native app delivery or a reminder authoring screen.
The HTTP fixture uses a minimal index page rather than the installed shell UI.

The task browser could not start Chrome: it exited with “No usable sandbox”. Browser and
installed native notification acknowledgement were not qualified. No physical second device,
Mac or Windows machine was used. No system certificate trust configuration was changed.

## Checks

Exact command outcomes and the final independent review are recorded in the task proof and
checkpoint PR. Rust commands use task-owned Cargo, rustup and target directories. All
DB-touching checks run through verify-gate on its disposable PostgreSQL server.

`pnpm test:rust-module-assembly` is the new executable integration gate. Worker unit checks
cover error retry and joining an in-flight pass before shutdown returns. Server unit checks
cover response-status preservation and malformed envelope refusal. Static checks cover the
changed Rust files, repository lint, formatting, file size and typechecking. A whole-workspace
Rust formatting result is not claimed for unrelated pre-existing path dependencies.
Module-host clippy with warnings denied stops on the unchanged
`folder_sync_status.rs:39` `int_plus_one` lint under Rust 1.95; it is not reported green.

## Left unbuilt, in order

1. Complete the automatic server/module bootstrap and installation join through the canonical
   Phase 1/7 installer, then port quiet-hours authority/deferral and notification metadata,
   links and deduplication before qualifying real reminder producers end to end. Qualify the
   changed acknowledgement path through the installed native Linux app. The explicit assembly
   is not automatically enabled for app-created local servers; module AI wiring also remains.
2. An independent notification process surviving app quit, saved-server activation routing
   and shared-client coordination.
3. Windows supervisor assembly and Stop under an ordinary account before enabling creation.
4. Normal-desktop pointer links, desktop-login autostart, hardware/composited rendering,
   target-root installation/removal and general clean-machine installation qualification.
5. Native macOS/Windows app and certificate qualification, OS public certificate trust,
   physical second-device LAN/tailnet HTTPS, signing, updates and production installers.

Workshop and Food remain unported. No rustls-platform-verifier was added. This is an explicit
assembly checkpoint with installed reminder delivery unverified; full section 13 parity is
incomplete. Do not treat this checkpoint's HTTP fixture as native live-path acceptance.

## Review follow-up

The first review's compile issue was fixed before the assembly gate. Module mute support and
its integration assertion were added; quiet-hours and producer metadata gaps are explicitly
left above. Minor limitations remain: module dispatch errors use a single bad-request status,
worker errors log once per failed pass, and the four dispatch slots plus worker share the
existing database pool. The new assembly gate is opt-in rather than wired into the full gate.
The public-route finding is declined: manifest validation already rejects routes without
sign-in (`rust-spike/module-host/src/manifest.rs`, “Module routes must be signed in and use safe paths”).
Unknown notify operations now bypass the transactional post branch and follow normal port
validation. These limits do not qualify real producer or installed native delivery.
