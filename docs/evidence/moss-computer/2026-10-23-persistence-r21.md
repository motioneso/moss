# Computer viewer and bounded replacement persistence: PASS

Task #3578 / parent #3577; integration #3605 remains open. The exact committed
[r21 packet](../../superpowers/plans/2026-10-23-moss-computer-viewer-r21.md)
`fd34c7ba78b95b3b7ad690ae8211a275f1cbcef7` completed the original offline acceptance sequence
at 2026-10-24 02:06:09–02:06:40 UTC. Independent read-only reviewer `/root/viewer_review`
accepted exact readiness, all 39 runtime/closure checks, and closure. Final committed evidence
review is recorded in the [review ledger](2026-10-23-independent-review.md).

Ben's direct instruction to continue repair superseded the earlier unsupported-repair kill gate.
The [initial unresolved report](2026-10-23-viewer-diagnosis.md) and spec section 26 describe that
historical checkpoint. They are not the current outcome. Original isolation, admission,
deadlines, assertions, independent review and cleanup protections remained in force.

## Observed acceptance

- Complete RFB 3.8 initialization passed at guest TCP, Unix WebSocket and gateway boundaries.
  Protected access, removed-mTLS, removed-origin and restored drivers returned 0/1/1/0 with
  intended rejection signals; gateway bytes were restored exactly.
- Actual current noVNC UI and RFB connected before and after replacement. The attached visible
  1280×800 canvases contained 346 and 338 sampled colours. Fresh initially absent files received
  the exact new token through actual viewer keyboard input in both desktops. No interception or
  synthetic frame substituted for these assertions.
- Actual Firefox about:support reported effective content sandbox level 6 twice. Actual tab
  processes had additional seccomp filters: five before replacement, four after; parent/profile,
  executable, environment, no-new-privileges and filter checks passed. User namespaces remained
  unavailable, as observed; no sandbox weakening was introduced.
- Clean browser UI shutdown removed the Firefox profile process and flushed its WAL twice.
  Pristine copied file/bookmark controls passed; changing file bytes and deleting exactly one
  bookmark failed at the intended assertions. Real durable hashes remained unchanged by controls.
- The original full desktop ID was removed and replaced with a distinct full ID, using the same
  adopted image and designated home. File and actual places.sqlite hashes matched the baseline
  before reopening the browser. The fresh browser first copied an exact distinct unbookmarked
  local URL, then bookmark-only search selected and opened the exact persisted target URL.
  Persisted file readback and final bookmark checks passed. The final database hash changed
  after the browser revisit; unchanged hashes are claimed through replacement before reopening.
- Initial and final actual isolation checks passed. Runner, persistence, watchdog, cgroup
  capture, cleanup and port release exited 0. Watchdog stop explicitly records `operator closure`
  and `NO_RUNNING_PROOF_CONTAINERS`; all six samples meet floors, heartbeat and home/socket
  threshold. These short samples do not establish sustained resource fit.

The [sanitized JSON](2026-10-23-persistence-r21.json) records exact identities, durable hashes,
predicates, exits, watchdog extrema and surviving input hashes. The
[raw-artifact hash manifest](2026-10-23-viewer-repair-artifacts.json) binds retained private
receipts, regressions and independent closure evidence. Raw homes, scripts and receipts remain
private sibling artifacts; ephemeral identity files were deleted.

## Diagnosis and targeted repairs

Every failed attempt remains a failure. Each corrected runtime used a separately committed,
independently reviewed packet and fresh identity/home/socket/keys/claimed port. The
[diagnostic plan](../../superpowers/plans/2026-10-23-moss-computer-viewer-diagnosis.md)
records the discriminating checks and corrections.

| Attempt | Observation and disposition                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r13     | Admission found Moss stopped. No image load or desktop launch. Ben authorized starting the existing container; no rebuild or deployment by this operator.                                                                                                      |
| r14     | A separate external production deployment replaced Moss during pre-load admission. Admission failed; no image load or desktop launch.                                                                                                                          |
| r15     | One reviewed exact archive restoration passed fresh admission and actual image/config/seven-layer verification. Runner then failed before desktop launch on an empty first watchdog log.                                                                       |
| r16     | Bounded first-complete-sample helper repaired that race. Viewer/frame/input passed; classifier rejected actual Gecko content processes whose argv was rewritten into one string.                                                                               |
| r17     | Exact known process-title normalization retained raw argv and all sandbox checks; actual-row old/new regression and rejection controls passed. Live sandbox/clean close passed; copied SQLite control retained an open connection/WAL.                         |
| r18     | Explicit copied-connection closure reached the intended bookmark-negative assertion in old/new fixture replay. Live initial address clipboard read then timed out; its cause remains unproven.                                                                 |
| r19     | Added actual keyboard-focus barrier and bounded clipboard diagnostics, without retrying shortcuts or enlarging deadlines. Live replacement/hashes/fresh viewer passed; about:blank rendered an empty address and could not satisfy literal clipboard readback. |
| r20     | Distinct observable unbookmarked local URL preserved the initial-state negative control. Live bookmark search showed the correct persisted suggestion, but Enter alone left search mode.                                                                       |
| r21     | One Arrow Down then Enter selected the suggestion. Actual caller regression preserved the unique query, original wait and exact target assertion. Complete live sequence passed.                                                                               |

The original r12 connection timeout remains causally unexplained. Repeated real current viewer
connections, frames and input now pass, but this is not evidence for a causal noVNC connection
patch. The handled package.json 404 still appears in passing r21 and is not treated as causal.
R18's initial clipboard timeout also remains unexplained; the focus barrier enforces a verified
input precondition rather than proving that earlier timeout's cause.

## Closure and delivery limits

Independent closure found exact proof/Compose containers and networks absent, recorded browser
and watchdog PID/start identities absent, no owned scripts, no claimed-port listener or
reservation, and no ephemeral keys. Historical failed attempts were closed separately. Retained
homes/archive remain; Moss is running healthy and `/health` returned `ok:true`.

This qualifies bounded offline amd64 file/bookmark replacement persistence, active Firefox
sandbox, clean profile flush and actual viewer/input only. Synthetic trial mTLS is not Moss
owner authentication. Actual owner HTTPS/WSS and active revocation, sole receiving input writer
and stale queue fencing/key release, app/browser UI integration, installed storage/lifecycle/idle
sleep-wake, confined Internet egress and release/platform cases remain open. There is no product
source/app-map change, database/foundation command, production deployment, merge or issue closure.
Draft #3612 remains stacked on unmerged draft #3607, itself on unmerged draft #3598.
