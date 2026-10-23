# #3578: r7 stopped at protected viewer access

**Outcome: REJECTED_INCOMPLETE_PROOF.** One supervised run stopped at the first protected owner
WebSocket assertion: HTTP502, expected101. Firefox/window testing, actual viewer input, sandbox
collection, persistence controls and guest replacement were not reached. No retry occurred.

Codex `/root`, session `01a169de-aa02-7990-a145-aadb18a73dbe`, actively operated and finished
`persistence-r7` in branch `fix/moss-computer-window-persistence`. Task #3578 / parent #3577 remain
open. The [launch packet](../../superpowers/plans/2026-10-23-moss-computer-persistence-r7.md) was
committed and independently accepted at `93cbe881ebe6645a8610c85246280d89aa6555ae` before launch.
The [sanitised receipt](2026-10-23-persistence-r7.json) records full container IDs, exits, timings,
resource/closure observations, all18 launch hashes and32 private receipt hashes. Private root is
sibling `../moss-computer-persistence-r7/`, outside canonical `~/Jarv1s`.

## Entry and exact prelaunch review

Read-only entry began17:46 UTC and completed within ten minutes. Initial transcript sample:
available RAM18,588,028,928 bytes, root free23,544,020,992, data free1,009,882,464,256. This initial
sample was not separately saved as raw output; retained pre-load receipt at17:48 UTC records
RAM13,801,873,408, root23,199,199,232, data1,009,811,963,904. Both passed RAM/root8GiB and data30GiB.
Moss was healthy. Historical image disappearance and reported Herdr restart causes remain UNKNOWN;
no infrastructure investigation, restart, prune, reclamation or substitute host/image.

Adopted image tag was absent. Actual retained archive size1,026,041,856, SHA256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`, actual config and all seven
layer digests were verified read-only, then independently accepted for one bounded load. Load
exited0; inspect matched exact image
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf` and all layers.
No runtime acceptance transferred from earlier trials.

Fresh independent home/socket, unique synthetic file/bookmark identity, one-day synthetic proof
certificates and newly reserved loopback5188 were prepared. Prior r6 and other homes/scripts/
receipts/archive were left alone. Live checks found parent draft #3588 and handoff draft #3587
open, #3579 merged; the child uses #3588's branch as its base.

Only private r7 window discovery, command-error handling and bounded failure diagnostics were
corrected. Title waits rediscover visible Firefox windows and verify class, actual binary and
profile-process arguments. Expected not-ready observations remain separate from errors; the
second identical normalized command error stops. Ranked hypotheses preceded fixes: replaced XID,
changed focus/dialog, or browser/backend exit. R6's actual lost-window cause remains UNKNOWN.

Focused private regressions observed a synthetic cached-ID BadWindow, then rediscovery passed.
Author/static review also caught a parameter shadowing the new command helper in initial candidate
`071a27801`: actual terminal call-site regression failed with TypeError, then passed after correction.
That candidate was NOT_READY and never launched. The amended packet/18 exact artifacts passed
independent review, including regression/syntax/configuration/certificate/reservation checks.
These seam tests do not qualify the real Firefox transition.

## Observed run and failure

| Stage            | Observed result                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live launch gate | Independent watchdog alive and first healthy sample: available RAM9,055,002,624 bytes, root22,797,508,608, data1,000,042,885,120; home/socket0.                                                                                                      |
| Launch/isolation | Launch0, initial isolation0. Actual exact image, UID1000, read-only roots, dropped caps, no-new-privileges/default seccomp/docker-default AppArmor, configured limits/mounts and sampled guest route/connect checks passed.                          |
| Protected access | Access driver1. First owner WS returned502 instead of101. The protected check failed before mTLS/Origin removal. Finally reloaded the unchanged pristine gateway configuration and verified its hash; full removal/restoration controls did not run. |
| Live diagnostics | Exit0 before teardown: bounded window tree/active client list, Firefox window search, process list, browser/terminal log tails and desktop backend tail. Xtigervnc/websockify/Xfce processes present; no Firefox window/process or browser logs.     |
| Missing gates    | Persistence harness and host browser never launched. No substantive viewer frame, fresh input, real Firefox/window/sandbox, clean UI flush, persistence red controls or replacement/post-replacement proof. Replacement operations=[] .              |
| Active finish    | Runner1, watchdog0, cleanup0, port release0. Fallback Firefox pkill returned1 with no Firefox launched. Live diagnostics/cgroup inspects preceded removal; independent closure readback followed removal.                                            |

Run17:52:04.577→17:52:10.871 UTC, approximately6.294s including closure. Guest/gateway limits
remained2CPU/4GiB/512PIDs and0.5CPU/128MiB/32PIDs, offline guest/Unix socket, separate trusted
bridge gateway, synthetic mTLS/exact Origin. No browser/container security weakening or product change.
These proof certificates do not establish Moss owner authentication.

The exact cause of502 is UNKNOWN. A startup-readiness timing gap is a hypothesis: the access check
began immediately after initial isolation, and later live diagnostics found websockify running.
Gateway upstream error logs and a socket-ready-at-request observation were not captured before
removal, so no specific missing-socket/refusal diagnosis is established. The assertion was preserved,
not retried or relaxed. This is not evidence of a Firefox sandbox/persistence failure or of a fixed
real-window transition.

Only one watchdog sample was retained, before launch; the brief run ended before a second nominal
sample. No continuous host-floor or sustained resource-fit claim follows. The prelaunch RAM margin
was465,068,032 bytes. Live guest/gateway cgroup snapshots and zero recorded OOM kills are in the
receipt, with no broader crash/host-stability diagnosis. Monitoring is not a storage quota; host
browser/daemon are outside caps. No new watchdog fault injection occurred.

## Closure and one next proposal

Operator closure readback found no owned labelled containers, project network, listener/reservation5188,
script/watchdog or recorded host-browser identity. Fresh keys/certificates were removed; new/prior
homes and candidate archive remain. Prior contents were not comprehensively rehashed. Moss remained
`running healthy`. No screenshots, broad install or DB/foundation commands were used. Exact final
independent review is recorded in the [review ledger](2026-10-23-independent-review.md).

Propose one separately reviewed startup-readiness qualification: distinguish bounded expected
not-ready observations from command errors before protected access assertions, require actual current
UI/RFB readiness, and capture gateway as well as guest backend diagnostics if access fails. Keep
all access assertions, image/security/resource/cleanup gates and current-window corrections intact.
This proposal dispatches no second run; persistence remains unqualified.

Idle sleep/wake is a future product requirement. No owner/session/AppShell/download/Internet,
manual MacBook/platform/installer/release, News or Direct On acceptance follows. No app-map/product
behavior changed. Draft child stays unmerged; no issue close or automatic parent adoption.
