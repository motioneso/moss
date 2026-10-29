# #3578: startup readiness r9 rejected at entry

**Outcome: BLOCKED_BEFORE_LAUNCH.** The initial fresh sample at19:15:05 UTC recorded available
RAM6,813,106,176 bytes, below the8,589,934,592-byte (8GiB) floor by1,776,828,416 bytes.
Root free54,376,660,992 and data free1,003,932,835,840 bytes passed their8GiB/30GiB floors.
The failed entry was not retried. No image load or runtime preparation followed.

Codex `/root` followed the [r9 handoff](../../superpowers/handoffs/2026-10-23-moss-computer-startup-readiness-r9.md)
on isolated branch `qualify/moss-computer-startup-readiness-r9`, based on merged main
`e37c5c84694a70a734fe195dc8e44d64d17b672b`. Live PR inspection confirmed #3596 merged at
19:08:26 UTC with that commit and the required handoff present. Task #3578 and parent #3577
remain open. R8's rejection and all prior qualification limits remain unchanged.

## Entry and mandatory stop

Read-only resource/image entry occurred at19:15:05 UTC; bounded closure/health checks completed
at19:16:06.785265 UTC, within ten minutes. The initial resource output was retained in the tool
transcript only. Private `entry.json` copies its values and timestamp; it is not a second sample
or separately saved raw command output. RAM alone failed. The exact adopted image inspect exited1
with no such image. Its tag was not separately inspected; no archive verification, restoration
review or load followed the failed resource floor. Image absence is not diagnosed further.

No fresh runtime home/socket/keys/scripts, launch packet, port reservation, host browser, watchdog,
container, network or viewer listener was created. The intended sibling
`../moss-computer-readiness-r9/` remained absent. No startup correction or hypothesis testing was
attempted; r7's protected502 cause remains UNKNOWN. No prior acceptance was transferred.

There was no capacity waiting/resampling, retry, reclamation, restart, prune, infrastructure
investigation, host substitution, rebuild, broad dependency installation or security relaxation.
The private evidence-only sibling `../moss-computer-readiness-r9-rejection/` was created after
stopping to preserve the ledger and rejection/closure receipts, outside canonical `~/Jarv1s`.

## Closure and limits

Operator readback found no exact r9 labelled containers, Compose project network or devports
reservation. Every read-only Docker/devports/health check exited0. Moss was `running healthy`
and its health endpoint returned `{"ok":true}`. The r9 runtime root did not exist; no owned
runtime process or ephemeral identity was started. Independent closure and exact evidence review
are recorded in the [review ledger](2026-10-23-independent-review.md).

Independent closure also found no r9 runtime processes. Its first broad process substring scan
matched the review shell itself and exited1; the corrected path-argument scan excluded shell command
text and exited0 with no owned runtime process. This was a review-instrumentation false positive,
not a resource resample or runtime failure.

Image load, runner, watchdog, runtime cleanup, port claim and port release exits are null because
those operations never ran. Closure readback exited0; this establishes closure after an entry
rejection, not exercised runtime cleanup/supervision. No port was allocated or listener bound.
Earlier homes including r7/r8 and the retained archive remained present. Their contents were not
comprehensively rehashed. The [sanitised JSON receipt](2026-10-23-startup-readiness-r9.json) records
numeric observations, unrun exits and private receipt hashes; raw host paths/logs stay private.

Startup/backend/gateway readiness, protected access/removal/restoration, actual current UI/RFB/frame,
fresh viewer input, runtime isolation and supervision are **NOT_RUN**. Active Firefox sandbox,
clean profile flush, replacement persistence, idle sleep/wake and Moss owner integration remain
unqualified. No screenshots, DB/foundation commands, production/Sports/News/Direct On changes,
product/app-map changes or manual/platform/release acceptance occurred.

Propose one separately dispatched continuation of the same bounded startup-readiness qualification
when host capacity is available, using a new unused identity, fresh floors, exact archive
validation/restoration review if absent, and a committed independently reviewed launch packet.
This rejection authorises no retry or second run, merge or issue close.
