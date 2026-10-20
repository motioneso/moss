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

## Third rereview of d8ea8e646

Both independent reviewers again ran with actual `claude-opus-5-5`. Standards
confirmed the earlier findings fixed or settled and found no blockers. Spec
confirmed all earlier medium defects fixed, no blockers, no medium defects and
no scope creep. Reviewers read code only; execution receipts below are separate.

Standards retained one low observation: repeated framing faults early in ring
inventory can delay later files until the failing source exhausts eight attempts,
potentially around an hour. This is bounded but not prompt isolation. Abandoned
or never-completed discoveries retain slots under the documented 100-entry limit.

Spec retained one low gap: an ended sidecar without a positive duration remains
discovered/pending, consuming a slot and being re-read. No such physical sidecar
has been observed. This malformed-source case was subsequently fixed in the final
follow-up below. Moss outage still pauses retrieval because live owner
verification deliberately precedes source access.

Final counts: Standards 0 blocking/medium, 1 new low plus the retained capacity
judgment; Spec 0 blocking/medium, 1 low. The final follow-up below addresses both
actionable low observations.
Manual retention and live owner verification remain deliberate preview limits.

## Verification status

Final host tests and signed SDK build pass. Installed device assertions pass,
including interrupted-read retry/backoff, oversized completed duration, durable
terminal identity conflicts, retained HTTP status, stopped/blocked outcomes and
frozen-state restart. Removing the server identity guard caused the corresponding
installed assertion to fail; the restored source passes.

Fresh clean-runtime installed-path gate `vocci_auto_delivery-20261020-073730.log`
passed with exit 0, including real transcripts/Meetings UI, four independently
re-downloaded hashes, bookmarks/modes, replay/restart and Stop. One manual Bluetooth
off/on recovery was required before retrieval; the hardware ledger discloses it.
Final CI belongs to the exact PR head; original hardware proof alone is not reused
as evidence for fixes.

## Final low-severity follow-up

Ended sidecars now require positive finite duration; missing, zero, negative or
non-numeric duration fails locally as `sidecar_invalid`, retaining the exact
sidecar and fetching no audio. In-progress sidecars still remain pending.

Each retrieval session now orders new/healthy sources before sources with earlier
failures. A repeatedly bad early inventory entry therefore cannot monopolize each
reconnect while later healthy files wait through its entire retry budget. Framing
faults still abort the session and retry from zero with finite per-source attempts.
Ordering is derived from durable attempts and survives process restart.

Installed assertions cover all invalid-duration variants, retained evidence and
absence of audio, plus healthy/new-before-failing priority across store restart.
The app map and README describe these outcomes. Exact final commit, subsequent
Opus dispositions and execution/CI receipts are recorded on PR #3551.
