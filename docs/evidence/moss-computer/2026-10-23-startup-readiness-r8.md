# #3578: startup readiness r8 stopped before image load

**Outcome: BLOCKED_BEFORE_LAUNCH.** The required fresh pre-load sample at18:36:17 UTC recorded
available RAM8,490,229,760 bytes, below the8,589,934,592-byte (8GiB) floor by99,704,832 bytes.
No image load or runtime launch followed. The resource gate was not retried.

Codex `/root`, session `01a16a09-742c-7ad2-b28b-1ba373a9b100`, followed the
[startup-readiness handoff](../../superpowers/handoffs/2026-10-23-moss-computer-startup-readiness.md)
on isolated branch `qualify/moss-computer-startup-readiness`, based on merged main
`7adef8b756d831245ca0050229b25c0213b8c6b8`. Live PR checks confirmed #3587, #3588 and #3595
merged before work began. Task #3578 and parent #3577 remain open.

## Entry and conditional archive acceptance

Read-only entry began18:33:26 UTC and completed by18:35:02 UTC, within ten minutes.
The initial transcript sample passed: available RAM8,677,879,808 bytes, root free54,327,566,336,
data free1,004,072,648,704. Its raw output was not separately saved. The retained entry receipt
at18:34:08 UTC also passed: RAM9,131,032,576, root54,326,714,368, data1,004,072,615,936.
Moss was `running healthy`; its health endpoint returned `{"ok":true}`.

The adopted tag and exact image digest were absent. The actual retained archive was verified
read-only: size1,026,041,856 bytes, SHA256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`, actual config hash
`c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`, Linux/amd64 and all seven
actual layer payload hashes matching the config. Reviewer `/root/readiness_review` independently
repeated those checks without edits or mutations and returned **PASS_RESTORE_READY**, conditional
on fresh resource floors before one load and exact identity/layer inspection afterwards.
That condition failed before load; archive acceptance grants no runtime acceptance.

## Preparation and mandatory stop

Fresh identity `readiness-r8` was checked unused by sibling-directory, exact container/network
labels and devports reservation name. Private sibling `../moss-computer-readiness-r8/` contains
fresh empty home/socket and retained receipts outside canonical `~/Jarv1s`.
`devports claim moss-computer-readiness-r8` reserved5184. No keys or certificates were generated.
Retained r7 scripts/receipts were inspected read-only; temporary new script copies were unexecuted
and discarded at closure except the closure checker. No startup correction or launch packet
was completed, committed or accepted before the stop.

Ranked hypotheses recorded before any correction were: guest socket/backend not ready at access;
gateway unable to reach the socket; backend exit/failure after spawn. Socket/backend probes,
gateway upstream logs and timestamped processes would distinguish them. None was tested.
The r7 protected502 cause remains UNKNOWN; no claim of a timing fix follows.

The fresh pre-load sample was RAM8,490,229,760, root54,320,136,192 and data1,004,072,312,832 bytes.
Only RAM failed. The wrapper exited1 at its assertion before calling `docker load`; image load,
runner and watchdog exits are null because those operations never ran. No waiting for headroom,
retry, reclamation, restart, prune, infrastructure investigation, rebuild or host substitution occurred.

## Closure and qualification limits

Port release exited0 and operator closure checker exited0. Readback found no exact owned
containers/network/listener5184/reservation, owned script/host-browser identity or ephemeral keys.
Fresh and earlier homes plus the archive remain; earlier scripts/receipts were not edited.
Moss remained `running healthy`. This is closure after preparation, not exercised runtime cleanup
or supervision. Prior retained data was not comprehensively rehashed.

The [sanitised JSON receipt](2026-10-23-startup-readiness-r8.json) records sample timestamps,
numeric preparation/closure exits, conditional archive review, actual seven layer hashes and
private receipt hashes. Raw paths/logs remain private. Exact final independent rejection/closure
review is recorded in the [review ledger](2026-10-23-independent-review.md).

Startup predicates, protected access/removal/restoration controls, actual UI/RFB/frame/input,
runtime isolation and watchdog supervision are **NOT_RUN**. Firefox transitions/sandbox, clean
profile flush, replacement persistence, idle sleep/wake and Moss owner integration remain
unqualified. No product/app-map change, screenshots, dependency installation, DB/foundation
commands, production/Sports/News/Direct On change or manual/platform/release acceptance occurred.

Propose one separately dispatched continuation of the same bounded startup-readiness qualification
when host capacity is available. Use a new unused identity, fresh floors, exact archive validation
and restoration review if absent, then a committed exact launch packet and independent review.
This rejection dispatches no retry or second run. No merge, automatic adoption or issue close.
