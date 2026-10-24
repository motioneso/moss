# #3578: r11 startup, protected viewer and fresh input pass

**Outcome: PASS — bounded startup/protected-viewer/fresh-input proof only.** Complete RFB
initialization replaced greeting-only probes. The single supervised run passed actual guestTCP,
UnixWS and owner/exact-Origin gateway readiness; protected access and removal/restoration controls;
current connected noVNC UI/RFB and substantive visible frame; exact fresh file bytes written through
viewer keyboard input; initial/final sampled isolation and active closure. Runner/watchdog/cleanup/
port release/operator closure all0. Independent closure accepted. No runtime retry occurred.

Ben said “yea fix it” after r10's rejection, authorising the bounded correction and one fresh
attempt under the [r9 handoff](../../superpowers/handoffs/2026-10-23-moss-computer-startup-readiness-r9.md).
Codex `/root` operated `readiness-r11` in the same isolated branch/worktree
`qualify/moss-computer-startup-readiness-r9`; private sibling `../moss-computer-readiness-r11/`.
The [exact launch packet](../../superpowers/plans/2026-10-23-moss-computer-startup-readiness-r11.md)
commit `be5359b437b4f3b2df5a74028797aa29c82d60a1` and all60 actual private artifacts received
independent PASS_LAUNCH_READY before the run. Earlier rejection reports/receipts remain unchanged.
Task #3578 and parent #3577 remain open; draft PR #3598 is not merged.

## Corrected observation and regression

Retained r10 code definitely closed guestTCP/UnixWS/gatewayWS/successful accessWS after greeting,
before client version, security selection/result or ClientInit/ServerInit. A protocol-contract
fixture against the actual copied gateway/access call sites showed success with zero completed
initializations. Corrected actual gateway/UnixWS/access call sites completed fragmented handshakes;
parser and guest regressions verified exact client bytes, fragmented/coalesced reads, refused
protocol/security rejection and bounded lengths/deadlines/early closure. The retained r10 refusal
payload is rejected. R7's terminal call-site/window regression, Python AST, Node syntax and resolved
Compose checks passed. Fixtures were closed and absent before proof; none ran in the live proof.

R11 uses the installed `ws` transport, including actual host Unix-socket observation, plus guestTCP
inside the offline guest. All positive probes exchange exact RFB3.8 version, choose None only when
advertised by the unchanged backend, require SecurityResult0, send shared ClientInit and consume
bounded complete ServerInit before closing. Blacklist/security settings and hard access assertions
were retained. Complete initialization fixes a probe defect; r11's passing sequence supports the
aborted-probe hypothesis but does not prove r10's blacklist trigger through a backend differential
reproducer. R7's prior502 cause remains UNKNOWN.

## Admission and one exact restore

Entry21:30:18.841119 UTC passed RAM25,478,639,616/root48,174,338,048/data991,001,382,912 bytes,
Moss healthy and health `{"ok":true}`. The adopted image was present, then explicit inspection
returned “No such image”, exit1, during preparation. Cause is UNKNOWN. Independent review accepted
the handoff's absent-image branch; no infrastructure investigation, retry, prune or restart occurred.
Actual retained archive size1,026,041,856, checksum, config identity and all seven layer payloads
were freshly verified and independently accepted. Pre-load21:37:39.905998 UTC passed RAM35,836,792,832/
root47,919,431,680/data985,741,422,592. One bounded exact load exited0; actual Linux/amd64 image
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf` and all seven layers
matched. No rebuild, substitution, viewer upgrade or earlier acceptance transfer.

Fresh root/identity/labels/reservation were checked unused before creation; new synthetic one-day
identities, home/socket and marker were prepared. `devports` freshly reserved5187. Runner enforced
fresh pre-launch admission21:42:20.493051 UTC: RAM36,218,392,576/root47,593,435,136/data983,216,959,488,
Moss healthy; the independent watchdog was alive with a healthy first sample before launch.
RAM/root floors8GiB and data30GiB passed throughout the two recorded samples.

## Single observed run

Run21:42:20.457899→21:42:31.288257 UTC lasted10.830358s including active closure. See the
[sanitised JSON receipt](2026-10-23-startup-readiness-r11.json) for exact operations/timestamps,
full IDs, observed protections and52 raw receipt hashes plus two support hashes.

| Gate                                              | Observation                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch / initial isolation                        | Both0; adopted image, UID1000, offline guest/Unix socket, actual caps/profiles/limits/mounts and sampled guest routes/connects passed.                                                                                                                          |
| Actual readiness                                  | Exit0;0.252s, all three stages ready on first observation. GuestTCP and UnixWS/gatewayWS completed RFB003.008, advertised None, SecurityResult0, shared ClientInit and complete1280x800 ServerInit. No expected-not-ready or instrumentation-error observation. |
| Protected access / red controls / restored access | Wrapper0; drivers0/1/1/0 with all intended signals. Owner/missing/foreign HTTP and WS plus exact-Origin assertions passed; removing mTLS/Origin produced the exact unchanged negative assertions; final restored complete RFB initialization passed.            |
| Pristine restoration                              | Actual gateway configuration SHA256 `f21f41333158ea294c67ae81f8aaea83a3ec08b999d22f6ae1de97dc48d39c70` equals reviewed pristine bytes. All four cases are present in raw controls JSON.                                                                         |
| Actual UI / substantive frame                     | Startup0; current UI connected and RFB connected; attached canvas1280x800, visible intersecting rectangle x0/y500/width1280/height800,345 sampled colours.                                                                                                      |
| Fresh viewer input                                | Unique file initially absent; exact unique bytes entered through actual noVNC `RFB.sendKey` and read back. Independent closure also checked retained bytes against the proof token. Host only prepared/activated the terminal.                                  |
| Post-input isolation / cgroups                    | Isolation-after0; actual protections remained. Guest sampled memory.current154,968,064/peak162,217,984 bytes/PIDs47; gateway4,001,792/peak7,282,688/PIDs5. Both sampled OOM/OOM-kill counters0.                                                                 |
| Active finish                                     | Browser closed; watchdog0, cleanup0, port release0, operator closure0 and independent closure accepted. No owned runtime/identity remains; Moss healthy.                                                                                                        |

The startup receipt includes one `/package.json`404 event; all required live predicates and input
checks passed. No screenshot, stub, interception or host-written marker was used. Failure diagnostics
were NOT_RUN because no live gate failed. No claim of an empty backend warning log follows.

## Closure, limits and next proposal

Independent read-only closure21:43:53.971326 UTC verified absent exact r11 containers/network/
listener5187/reservation/scripts/watchdog/recorded host-browser PID-start identities/ephemeral keys,
pristine restored configuration, retained new/prior homes/archive, exact marker bytes and healthy
Moss/health. All34 surviving launch files remained exact;26 ephemeral identity files were deleted.
Prior homes/archive were retained without comprehensive content rehash. A supplemental operator
check initially wrongly assumed r9 had a prepared private receipts directory; it exited1 and was
corrected to verify r9's tracked no-preparation rejection report/JSON. This read-only check correction
caused no runtime or admission retry; its note is retained.

Guest2CPU/4GiB/512PIDs and separate trusted gateway0.5CPU/128MiB/32PIDs, synthetic mTLS/exact Origin,
read-only roots, dropped capabilities, no-new-privileges/default seccomp/docker-default AppArmor,
bounded tmpfs/logs and no devices/Docker socket/production mounts were retained. Two short watchdog
samples at0/5s establish only sampled floors. Monitoring is not a quota; browser/daemon remain
outside container caps. No sustained-fit, full isolation theorem or fault-injection acceptance.

Synthetic identities do not prove Moss owner authentication. Active Firefox sandbox, clean profile
flush, replacement persistence, idle sleep/wake, manual-device/platform and owner integration remain
unqualified. Ben's requirement for the same Computer inside the Moss app AND browser, including
watching/takeover/explicit return of control, is recorded in spec§21; those surfaces are not delivered
by this proof. No shipped product/app-map, DB/foundation, Internet/download, production/Sports/News/
Direct On, installer/release or reusable proof-tool change occurred.

Propose one separately dispatched bounded active-Firefox/sandbox, clean-shutdown and replacement-
persistence qualification using the exact adopted image and inherited protection/review/closure
gates. No automatic second run, merge, issue closure or owner-integration build follows.
