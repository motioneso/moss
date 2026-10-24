# #3578: r10 readiness probes passed; restored access rejected

**Outcome: REJECTED_INCOMPLETE_PROOF.** One supervised run passed positive guest/socket/gateway
probes, initial sampled isolation, protected access and both protection-removal controls. The final
restored driver exited0 but returned `RFB 003.003` with **“Too many security failures”**, so the
required `RFB 003.008` signal failed. The access-control wrapper and runner exited1. No retry occurred.
Actual UI/RFB/frame/fresh-input testing was NOT_RUN.

Ben explicitly said “proceed” after the later RAM status recovered, authorising one fresh attempt
under the [r9 handoff](../../superpowers/handoffs/2026-10-23-moss-computer-startup-readiness-r9.md).
Codex `/root` operated fresh `readiness-r10` in the same isolated worktree/branch
`qualify/moss-computer-startup-readiness-r9`. R9's rejection remains unchanged. The committed
[exact packet](../../superpowers/plans/2026-10-23-moss-computer-startup-readiness-r10.md)
`346ca8ff9e11005b359e497bc9d4a0f87b00da25` and46 actual private artifacts received independent
PASS_READY before launch, conditional on fresh floors and an alive/healthy first watchdog sample.
Task #3578 and parent #3577 are left open; no merge or issue close is performed.

## Fresh preparation and restoration

Entry21:14:06.781965 UTC passed: available RAM29,907,628,032, root free48,547,307,520 and data
free999,886,635,008 bytes; Moss healthy and health `{"ok":true}`. Entry/archive verification finished
within ten minutes. The new identity/root/labels/reservation name were checked unused before creation.
Fresh private sibling `../moss-computer-readiness-r10/` contains new home/socket/scripts/receipts
and unique marker metadata. Newly claimed port5184 is a fresh reservation, not r8 identity reuse.
Earlier homes including r7/r8, r9 rejection evidence, scripts/receipts and archive were preserved.

The exact adopted image was absent. Actual archive size1,026,041,856 and SHA256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`, actual config identity,
Linux/amd64 and all seven actual layer payloads were verified and independently accepted afresh.
Pre-load21:16:47.844091 UTC passed RAM27,653,943,296/root48,451,657,728/data993,990,848,512.
One bounded load exited0; actual image
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf` and all layers matched.
No rebuild, viewer upgrade, substitute, reclamation or prior acceptance transfer occurred.

Before correction, hypotheses were guest/backend startup timing, gateway socket reachability and
backend exit after spawn. Only bounded startup observation and live guest/gateway failure capture
were added. R7 window/error and actual terminal call-site behavior were retained. The copied
prelaunch regression first referenced missing `persistence.mjs`; its exit1/log remain. Pointing that
test at actual `startup.mjs` made it pass. This preparation error did not launch runtime or affect
restoration. Independent review's first receipt comparison assumed a full Docker-inspect schema;
its read-only KeyError was corrected to the actual compact receipt schema, without artifact changes.

## Single observed run

Pre-launch21:21:15.838371 UTC passed RAM31,577,821,184/root48,287,723,520/data988,008,660,992.
Watchdog was alive with healthy first sample before launch. Run21:21:15.878747→21:21:26.823888 UTC,
10.945141s including closure. Numeric exits and timestamps are in the
[sanitised JSON](2026-10-23-startup-readiness-r10.json).

| Gate                       | Observation                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Launch / initial isolation | Both0. Exact image, UID1000, offline guest/Unix socket, limits/default profiles/mounts and sampled route/connect checks passed.                                                                                                |
| Positive backend probes    | Exit0,0.267s: guest loopback actual `RFB 003.008`, Unix WebSocket101 plus RFB, then gateway owner-certificate/exact-Origin101 plus RFB. Both stages ready on first observation; no expected-not-ready/error sample occurred.   |
| Baseline access            | Driver0; required RFB003.008 and owner/foreign/missing-identity HTTP/WS and exact-Origin status assertions passed.                                                                                                             |
| mTLS / Origin removal      | Drivers1/1, each at the unchanged intended red assertion. The Origin-removed foreign-origin WS was101; its payload also reported backend refusal.                                                                              |
| Restored access            | Driver0 and expected HTTP/WS status assertions passed, but required RFB003.008 was absent. Actual owner payload contained RFB003.003 plus the explicit “Too many security failures” reason. Wrapper1/runner1 reject the proof. |
| Restoration bytes          | Actual gateway configuration SHA256 equals pristine reviewed hash `dc290b02ea1f4bf848c033c73deb3efae12471e4983a9a703846c9d2b3b60a54`.                                                                                          |
| Live failure capture       | Exit0 before teardown: timestamped live guest AND gateway process/socket/log observations, actual gateway config, guest window/terminal diagnostics; all captured commands0. Both containers were running at capture.          |
| Active finish              | Watchdog0, cleanup0, port release0; operator closure0. Browser/startup harness never launched.                                                                                                                                 |

The numeric driver sequence0/1/1/0 matched, but the fourth required protocol signal did not; this
is not full access-control acceptance. Raw `access-controls.json` was saved by `finally` before the
restored check, so it contains only three cases. The fourth failed row is retained in the wrapper
traceback and actual restored-driver output; the public receipt labels that reconstruction explicitly.
The restored protocol is46 bytes:12-byte `RFB 003.003\n`, eight-byte failure header
`000000000000001a`, then26-byte `Too many security failures`.

Live guest logs explicitly record `Connections: blacklisted: 127.0.0.1` at21:21:21.367 and
21:21:22.388 UTC. The gateway logged an upgraded-connection upstream reset104 at21:21:21.368.
The Unix socket was present with UID1000/mode0600 in both views. These establish r10 backend
blacklisting/refusal, not why it was triggered. Greeting-only/aborted probes influencing backend
accounting is a hypothesis requiring separate diagnosis. R7's earlier502 cause remains UNKNOWN;
positive r10 probes neither diagnose nor retroactively fix that failure.

## Closure and limits

Guest/gateway retained2CPU/4GiB/512PIDs and0.5CPU/128MiB/32PIDs, network-none guest/Unix socket,
separate trusted bridge gateway, synthetic mTLS/exact Origin, read-only roots, dropped capabilities,
no-new-privileges/default seccomp/docker-default AppArmor and bounded tmpfs/logs. No security
weakening or production mounts. Synthetic certificates do not prove Moss owner authentication.
Two watchdog samples, at0.0/5.1s, showed healthy floors; no sustained fit or continuous headroom
claim follows. Monitoring is not quota; host browser/daemon remain outside caps. No new fault
injection or product/app-map change occurred.

Operator and independent21:22:18.829250 UTC closure found no owned containers/network/listener5184/
reservation/scripts/host-browser identity or ephemeral keys. Home and all earlier homes/archive
remain present; contents were not comprehensively rehashed. Moss was `running healthy`, health
`{"ok":true}`. Accepted prelaunch credential hashes remain recorded; actual ephemeral credentials
were deleted. Exact private hashes and full container IDs are retained; raw paths/logs stay private.
Independent exact final review is recorded in the [review ledger](2026-10-23-independent-review.md).

UI/current-RFB/substantive frame/fresh viewer input and post-input isolation were NOT_RUN. Active
Firefox sandbox, clean profile flush, replacement persistence, idle sleep/wake and Moss owner
integration remain unqualified. No screenshots, stubs/interception, broad install, DB/foundation,
production/Sports/News/Direct On, manual MacBook, installer/platform/release acceptance occurred.

Propose one separately dispatched bounded diagnosis of greeting-only/aborted RFB probes and backend
blacklisting. Preserve exact image/security/access assertions; independently review any bounded
correction before a fresh startup/UI/input attempt. Do not disable blacklist/security protections
or retry this run. No automatic second run, merge, issue close or product expansion follows.
