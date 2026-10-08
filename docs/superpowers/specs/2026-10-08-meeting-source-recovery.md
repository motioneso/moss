# Meeting source-format recovery (#3123)

## Scope and decision

A format or sample-clock change on the same authorized audio sources should restart capture automatically. Quiesce the selected microphone/output pair, obtain a new immutable server epoch, reopen the identical selection, and mark honest gaps on both interrupted tracks. Keep the meeting's monotonic origin and existing echo-cancellation/fallback behavior. Separate per-source lifecycle machines are out of scope.

This is a bug fix against current main, after #3120. The implementation plan was supplied to the owner before code changes. This document records that plan; it does not claim live proof or permission to merge.

## Invariants

- Only positive, typed format-change or valid sample-discontinuity evidence qualifies. Malformed timestamps, NaN, overflow, monotonic reversal, capacity, permission, listener, missing device, route, application membership and exclusion changes remain hard failures.
- Close capture and send admission before teardown or network work. Hard scope faults win over concurrent recoverable faults, including changes that disappear before the next inventory read.
- Pin original physical microphone, speaker/reference route, selected application membership and Moss exclusions. Recheck before and after acquisition. Never switch devices, silently widen scope, or prompt for permission during automatic recovery.
- Fully dispose failed units before attempting replacement. New eligible VPIO setup incompatibility may use the existing same-microphone HAL fallback. Running failures do not directly fall back.
- The explicit native recovery command requires a live recording grant/lease, expected generation and epoch, and the identical selection. Paused, stopped, revoked and idle captures cannot recover automatically. Stable request keys make retries idempotent.
- A confirmed control response is insufficient to upload: ordinary status must confirm the new epoch and then acknowledge its recording observation. Old replies and callbacks cannot admit fresh audio or mutate a newer operation.
- One bounded episode owns attempts and a monotonic deadline, capped by authorization lease. Every RPC/backoff consumes that budget; recurring faults and immediate restart failures do not reset it. Pause, Stop, permission/scope loss and revocation cancel immediately.
- Retire expired old offers as gaps without assuming receipt success, changing offered bytes/keys, resetting old sequence numbers, or allowing old expiry to pause the fresh epoch. Server pending receipt accounting remains bounded across epochs.

## Presentation

Show "Recovering audio…" while capture is interrupted. A hard pause must surface a persistent visible warning, including if the recording pill was hidden. Keep explicit Pause and Stop usable during recovery. Do not claim audio is recording during the gap.

## Verification and release gate

Cover microphone/output/VPIO format changes, valid clock reset, unchanged reference notifications, unchanged authorized sources, route/scope/permission loss, cleanup failures, cancellation and late-response races, duplicate controls, limits, delayed Resume and unknown expired receipts. Observe regression tests failing without their protection. Run the actual app-map build and complete meeting manifest test, lint, formatting, root/test TypeScript checks, applicable portable checks and hosted native tests. Database tests use only the repository verify-gate procedure.

Installed Mac proof remains mandatory: browser call and native Teams before and during recording, delayed Resume after retention expiry, and real device/permission loss. Keep the PR draft and describe it as unverified until this proof exists. Linux checks cannot substitute for native or live proof.
