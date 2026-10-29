# #3578: adopted-image persistence proof rejected at window transition

**Outcome: REJECTED_INCOMPLETE_PROOF.** One supervised runtime was launched and closed; no rerun.
The harness lost a cached Firefox window ID before collecting active sandbox diagnostics. No
clean UI flush, persistence controls, guest replacement or post-replacement acceptance occurred.
This is a harness-stage rejection, not evidence that Firefox's sandbox or persistence failed.

Codex `/root`, session `01a16981-6c86-7df1-82ab-397cf5db2e90`, actively operated and finished run
`persistence-r6`. Task #3578 / parent #3577 remain open. The
[launch packet](../../superpowers/plans/2026-10-23-moss-computer-persistence-r6.md) was committed and
independently accepted at `08a3b2111d6d79ff2aa3972ab56f655e32ed10ef` before launch. The
[sanitised receipt](2026-10-23-persistence-r6.json) records exact IDs, exits, timings, raw hashes and
limits. Private scripts, receipts, home and diagnostic copies remain in sibling
`../moss-computer-persistence-r6/`, outside canonical `~/Jarv1s`.

## Fresh entry and reviewed launch

Ben resumed after closing Zen. Fresh entry16:51 UTC passed: available RAM19,916,611,584 bytes,
root free9,003,347,968 and data free1,033,569,468,416. The adopted image was absent. Actual retained
archive size/checksum, config identity and all seven uncompressed layer digests matched; one bounded
load returned0. The wrapper subsequently exited1 because its expected-ID literal was mistyped.
That instrumentation failure is retained. Direct inspect matched the independently verified config
exactly; there was no second load, rebuild, replacement candidate, host repair, restart or prune.

Image: `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
The reviewer independently verified archive/config/layers and the exact15 final launch artifacts.
Earlier prelaunch reviews rejected wrong content classification, an environment-check exemption,
incomplete disposable controls/WAL handling and shutdown/cleanup gaps. Revised bytes were committed
and accepted before any runtime. Readiness acceptance did not establish runtime acceptance.

The independent watchdog was alive with a healthy sample before launch: available RAM19,291,643,904,
root free8,660,062,208, data free1,032,571,895,808. Fresh offline UID1000 guest, dedicated home/socket,
loopback5188, synthetic mTLS/Origin gateway and existing container/browser restrictions were retained.
Guest2CPU/4GiB/512PIDs; gateway0.5CPU/128MiB/32PIDs, read-only roots, dropped caps,
no-new-privileges/default seccomp/docker-default AppArmor, bounded tmpfs/logs. No production mounts.

## Observed path and exact failure

| Stage                 | Observed result                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer                | Actual current UI/RFB connected; attached visible/intersecting1280x800 frame,345 sampled colours.                                                                                                                                                                                       |
| Fresh input           | Unique designated file initially absent; real noVNC keyboard wrote exact token, host readback matched. Host only prepared/activated terminal.                                                                                                                                           |
| Access controls       | Protected/restored checks exit0. Removing mTLS makes unchanged missing-cert assertion fail at HTTP200; removing Origin makes unchanged foreign-Origin assertion fail at WS101. Red cases exit1/1, exact config restored. These are synthetic identities, not Moss owner authentication. |
| Guest isolation       | Actual image/user/caps/default profiles/limits/mounts checked. Network none, no published guest port; bounded metadata/private-range attempts ENETUNREACH and guest localhost1533 ECONNREFUSED. Sampled checks, not universal certification.                                            |
| Firefox transition    | Real dedicated-profile launch reached fixture-title/address assertions and bookmark keyboard sequence. During transition to the second diagnostics tab, cached window decimal29360173 (`0x1c0002d`) became invalid. `getwindowname` returned BadWindow;15s polling timed out.           |
| Material harness flaw | 47 BadWindow occurrences in retained log, including final error. Polling swallowed identical command failures instead of stopping/rethinking after two. No corrective runtime was attempted.                                                                                            |
| Remaining gates       | No about:support/process receipts, clean viewer close, flushed-profile qualification, red persistence controls, replacement operations or post-replacement proof. Mutation operations list is empty.                                                                                    |

The observed invalid cached identifier explains the immediate assertion failure. Why that window
was destroyed, which replacement/dialog window existed, and whether focus or a Firefox event caused
it remain UNKNOWN. No final live window-tree or guest Firefox/backend log was captured before
container removal; retrospective reconstruction cannot establish those facts. Container OOM kills
were0, and resource floors passed sampled checks; that is not a full Firefox-crash diagnosis.

After cleanup, a disposable copy of the retained profile including its WAL contained the exact
unique bookmark URL/title. The real home was not edited for that diagnostic. Its retained main
SQLite/WAL hashes are recorded. This confirms observed persisted bytes after fallback SIGTERM,
not a qualified clean UI flush, negative control, replacement or active sandbox. The real Firefox
process existed until fallback closure; no claim is made that the attempted tab transition or
about:support copy succeeded.

## Active closure and limits

Runner17:05:48.816→17:06:40.751 UTC, approximately51.935s. Launch, initial isolation and access driver
exited0; persistence harness and runner exited1. Firefox fallback SIGTERM exited0. Independent
watchdog normal operator closure exited0 and verified no running proof containers. Cleanup and
port release exited0. Full desktop and gateway IDs are recorded. Final inspect/cgroup snapshots
were captured while services still ran, before cleanup; separate closure receipts establish absence.

Ten watchdog samples: minimum available RAM9,295,101,952 bytes; root free8,628,154,368 (only38,219,776
above8GiB); data free1,032,532,877,312; maximum sampled home/socket39,483,975. Desktop peak1,000,796,160
bytes, gateway13,123,584; cgroup OOM kills0. This is no benchmark or host-stability certification.
Sampled10GiB threshold is not a quota; host browser/daemon are outside guest caps.

Closure rechecks and independent review found no owned labelled containers, project network,
listener/reservation5188, script/watchdog or recorded host-browser identity. Fresh synthetic keys
and certificates were removed; new/prior homes and candidate archive remain. Prior data was not
content-rehashed. Moss remained `running healthy`. No DB/foundation command, screenshots or broad
install was used. Exact final independent evidence review is recorded in the
[review ledger](2026-10-23-independent-review.md).

Idle sleep/wake remains a future product requirement. No Moss owner/session/download/Internet,
manual MacBook/platform/installer/release, News or Direct On acceptance follows. No app-map/product
behavior changed. Historical image disappearance and reported Herdr restart causes remain UNKNOWN.
Draft #3588 remains unmerged; no issue close or parent adoption.

## One next proposal

Prepare a narrowly corrected Firefox-window transition: rediscover and verify the current browser
window rather than repeatedly querying a cached ID; distinguish expected not-yet-ready observations
from command errors, and stop on the second identical error. Preserve a bounded live window-tree and
browser/backend diagnostic on failure. Independently review exact revised artifacts, then separately
dispatch one fresh proof only after resource floors pass with the same image/isolation/supervision
bounds. No new run or integration is dispatched by this proposal.
