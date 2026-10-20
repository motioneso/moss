# Vocci Android independent Opus review

PR #3551, task #3550. Two independent read-only Claude Opus reviews ran against
`b881facf14cd1d20eb1a806d76e2e91e86d7f7ba`, compared with pinned base
`9707a40ba0f5c9b11405970dcae3f4a2f550a475`. CLI receipts identify the actual
model as `claude-opus-5-5`. Private review transcripts stay outside git.

## Standards

Documented findings:

- Medium: the app-map remediation appeared to promise Android setup instructions
  at Meetings settings, which has none. Clarified that settings only enables the
  receiver and named the source README for Android developer setup.
- Low: `server_unavailable` was absent from declared errors. Added it and declared
  the recording integrity failures exposed by the revised client.
- Medium: server identity/mode changes fell through to transient transfer retry,
  losing their specific errors. Added a typed terminal conflict and retained code.

Judgment calls: move direct attempt mutation into the store; consider enums and a
configuration type; repeated auth checks/hash formatting; unclear inventory/capacity
names; service mixes notification, retrieval, sidecar parsing and delivery; failure
allowlist is rebuilt. Moved attempt mutation into `abandonAttempt`, extracted
completed-sidecar parsing, clarified names and made the allowlist static. Retained
small stage/config JSON contracts rather than expanding this developer slice with
an unrelated type refactor. Independent device hash verification remains explicit.

The reviewer found no blocking security/data-path issue; acknowledged the existing
spec/task/plan, plain release note, and disclosed developer/OS credential boundary.

## Spec

- High: an unsupported filename, malformed sidecar or packet gap could prevent
  later recordings from being retrieved. Unsupported inventory entries are now
  ignored; invalid sidecars are retained and failed individually; packet validation
  happens after exact sources are retained and fails only that queue entry.
- Medium: eight failed connections permanently stopped retrieval until restart.
  Connection attempts now continue with a delay capped at 30 minutes; uploads
  retain finite attempts. A returning ring can resume without manual restart.
- Low: Stop could store a false configuration failure, repost a notification or
  lose an interrupted GATT wait. Preserve interruption, serialize reporting with
  destruction, suppress reports after Stop and store a stopped outcome.
- Low: discovered/blocked states and pending counts were missing. Persist discovery,
  expose blocked service outcomes, and count pending queue entries in notifications.

No scope creep found. Ring reboot, OS reclamation and interrupted BLE reads on
hardware remain explicitly unverified; do not infer these from host assertions.

Initial counts: Standards 3 actionable findings plus labeled judgment calls;
Spec 4 findings. Worst within Standards: lost terminal conflict identity.
Worst within Spec: one invalid source poisoning delivery of later sources.

## Rereview of 5a7a42ab7

Standards confirmed all three original actionable findings fixed. It found a
new medium defect: framing exceptions were made terminal although some reflect
transient connection faults. Low findings: terminal non-auth session rejection
looked like active retry, stable local error codes were missing from the map,
and abandoned discoveries retain queue capacity. Changed framing failures to
bounded per-source retries, differentiated blocked server rejection, and declared
stable errors while preserving numeric HTTP status. Abandoned discoveries remain
retained evidence under the explicit 100-entry/manual-retention limit.

Spec confirmed its four original findings fixed. It independently identified the
same transient-framing defect and a second medium defect: over-duration completed
sidecars remained pending forever. It also noted an optional limitation: retrieval
requires successful live owner verification, so a Moss outage pauses ring retrieval.
Preserved that authorization ordering. Oversized completed durations and advertised
sources now become explicit failed entries; their allowed evidence stays retained.

Rereview counts: Standards 1 medium and 3 low findings/judgments; Spec 2 medium
findings plus a disclosed nonblocking outage limitation. Worst within Standards:
prematurely terminal framing failure. Worst within Spec: the same framing failure.

## Verification status

The revised runtime still requires final device/live checks, CI and independent
Opus rereview before merge. The original hardware run is not evidence that these
new recovery changes have been exercised through the installed path.
