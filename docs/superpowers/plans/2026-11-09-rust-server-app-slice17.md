# Rust server/app slice 17 checkpoint plan

Part of https://github.com/motioneso/moss/issues/4027. JS-164. Category: N/A.

1. Advance due schedules through the existing Phase 2b queue on each module-worker pass.
   Exercise a schedule-only Wasm module before and after upgrade without manually ticking
   the scheduler in the test.
2. Persist desktop notification acceptance in the server, scoped to the signed-in recipient
   and a stable client ID in each server profile. Keep notification reads independent. Retry
   failed writes; keep generic banners and the existing quiet first-visit behavior.
3. Verify actor/client isolation, restart persistence and HTTP integration on disposable data,
   run static checks, commit and obtain a fresh read-only review, then publish proof and a
   checkpoint PR. Keep scratch state outside the repository.

This checkpoint does not add a reminder authoring screen, a server/module-host assembly or a
standalone notification process. Those integration steps, saved-server activation, Windows
supervision and unavailable target/device qualification remain explicitly unbuilt. No new
third-party package, OS certificate verifier, Workshop or Food port is authorized.
