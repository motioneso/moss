# Delayed restart and visible reload: recovery-r4

Dispatched by Ben on 23 October 2026 through the [handoff](../handoffs/2026-10-23-moss-computer-delayed-recovery.md).
Task #3578 / parent #3577; child of draft PR #3581 and parent draft PR #3579.
This packet dispatches one actively supervised delayed-restart/reload proof after exact independent
readiness review. No merge, parent adoption, issue close or product integration.

## Operator, identity and scope

Codex `/root`, session `01a16941-f698-7f43-bac7-3c699b5576c6`, is the active automated finish
operator in branch `fix/moss-computer-delayed-recovery`, based on r3 result
`3c263929433d3a63df08d538fa44339692bc9598`. Independent reviewer has read-only responsibility;
reviewer never authors fixes. Parent worktrees remain parked.

Run `recovery-r4` uses fresh private home/socket/runtime and synthetic one-day proof CA/server/client
identities. `devports claim moss-computer-recovery-r4` reserved loopback5189. Exact adopted amd64
image `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`
is present; no archive load/rebuild needed. noVNC1.3/Websockify0.13/TigerVNC1.12/Xfce4.18/Firefox
ESR153.5.1 remain unchanged. Prior homes and retained candidate archive stay untouched.

Only Computer plan/spec/evidence/handoff documents are owned. Private script/receipt references
resolve from sibling `../moss-computer-recovery-r4/`, outside canonical `~/Jarv1s`; no raw host logs,
credentials or runtime paths are committed. Existing spike source is unchanged. No product/app-map
change; News, Direct On, Internet, shared auth, AppShell, installer and release gates stay separate.

## Bounded host preflight

Read-only inspection from14:55 to15:01 UTC, under10 minutes. Host boot20 October21:46:59 local;
Docker active since20 October21:49:01 local, NRestarts0. Herdr process start observations on23 October
06:53:52 and07:09:19 local establish process times, not cause. No Herdr user service was found.
Initial user-bus lookup unavailable; existing user bus worked on retry. Bounded recent Docker
(last120 lines within2h,32 returned), kernel(last150) and user(last250) log slices had no matched
OOM/I/O/Docker-restart patterns. This is incomplete incident coverage, not proof of no incident.
Reported unexpected Herdr restart and image disappearance causes remain UNKNOWN. No host repair,
restart, prune or forced failure. Fresh candidate exists and Moss is running healthy.

Snapshot: available RAM17,736,851,456 bytes; root free13,784,465,408; data free1,032,718,471,168.
Swap substantially used. These are entry snapshots, not a performance claim. Fresh floors and
watchdog first healthy sample/alive are rechecked before launch; any failed gate stops launch.

## One real-path loop and measurable acceptance

Use targeted installed Node Playwright/ws from `~/Jarv1s/package.json`, no broad install. Preserve
r3 correction: import actual UI once, synchronously poll `UI.connected` and current
`RFB._rfbConnectionState`; async wait predicates do not qualify readiness. Fresh browser, viewport
1280×1800. No screenshots, stubs or synthetic success responses.

1. Before crash, require connected UI/RFB, attached visible canvas >=100×100 with positive viewport
   intersection, visible styles and >=10 sampled colours. Send a fresh unique file command through
   actual noVNC `RFB.sendKey`, read back exact marker; check destination absent first. Host may
   prepare/activate terminal only. Rerun current-image access/removal/restoration and isolation checks.
2. Kill only exact guest ID. Observe disconnect, capture DOM/live and detached prior RFB canvas,
   framebuffer geometry/colours, console, WS opens/closes/messages/bytes and bounded backend logs.
   Require Moss still running healthy.
3. Keep guest stopped until actual terminal “Failed to connect to server”, UI disconnected, RFB
   absent and no reconnect callback, within15s. This observes failed automatic retry, not a sleep
   claim. Run the same substantive frame assertion while stopped: expect actual12s TimeoutError,
   preserve failure snapshot while page open; unexpected success rejects the loop.
4. Restart exact guest via fixed host `docker start`. Perform exactly one browser `page.reload`
   (the visible browser reload action), record request/return timestamps. Require a new document ID,
   fresh current UI/RFB connected, substantive visible canvas and fresh unique viewer-keyboard file.
   Record kill→restart downtime and reload→frame/input times, with finite exit.
5. Close browser; record phase resource samples and final cgroup limits/peaks/events (restart resets
   guest peak). Actively close watchdog/services, then remove only run-owned containers/network,
   release5189 and remove ephemeral keys. Retain designated new home, prior homes/archive. Verify
   no owned script/browser/watchdog/listener/runtime and Moss healthy before final acceptance.

This is one fresh real-path proof with an embedded stopped-guest red control, not a stack-fix
search. Preserve material failures. Two identical failures require scope/design stop; no blind
viewer upgrade, security weakening, reusable tooling expansion or host substitution.

Ranked falsifiable hypotheses, presented before any fixes: (1) automatic retry exhausts while down,
so terminal failure precedes reload recovery; (2) stale page RFB state prevents recovery, so fresh
document/RFB changes state; (3) transport precedes substantive rendering, so early one-colour frame
fails separately; (4) current host instability independently fails health/resource/backend gates.
Reload is the single changed recovery action; no runtime image/configuration change is proposed.

## Isolation, supervision and failure boundaries

Desktop UID1000, network none/Unix socket,2CPU/4GiB/512PIDs. Separate trusted Nginx bridge gateway
0.5CPU/128MiB/32PIDs, synthetic mTLS and exact Origin on loopback5189. This is not Moss owner auth.
Read-only roots, dropped capabilities, no-new-privileges/default seccomp/AppArmor and browser sandbox
retained. No devices, Docker socket or production mounts. Home/socket alone writable; gateway keys
are absent from guest mounts. Bounded tmpfs and rotated logs retained. Sampled isolation tests are
not universal isolation certification.

Independent watchdog uses exact fallback/closure label `com.moss.proof=recovery-r4`. Start before
Compose launch, verify alive plus first healthy sample. Deadline1800s, heartbeat90s, nominal5s
sampling; fail closed on measurement/log failure, RAM/root below8GiB, data below30GiB, or home+socket
at10GiB. Threshold is not a quota. Stop services before final receipt, fallback exact-label kill,
then verify zero running labelled containers. Active operator handles removal and final controls.
Host browser/Docker daemon work is outside container caps. Finish well before60-minute outer limit;
no unattended desktop or timer-only completion. No new watchdog fault injection is dispatched.

## Exact launch artifacts

Private root and resolved configuration are inspected by independent reviewer; paths remain private.
These exact bytes must match at launch:

| Artifact                        | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `compose.yaml`                  | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `gateway/nginx.conf`            | `db73dba675487afbf4690bc05da04f24ba215ade649471516bcb2de8d8acf6be` |
| `supervise.py`                  | `dea9bbce87445f0f1dbda6aa32903602ec9e0796375ff28b288c928c24189c6a` |
| `recovery.mjs`                  | `10a19a006ffb292f4948c98dc829d0c255e8889988f760a99a3d31a05a7ca3dd` |
| `access-check.mjs`              | `d286deabe7b30f6b51e62e5f2d7571d69e24a7056a3589176442348d260dea89` |
| `access-controls.py`            | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `isolation.py`                  | `ab5bdd7418ed794f6eb02fad39a404bba2e6b95ad7eaad3d9a9fc0a2dc3e33f2` |
| `receipts/resolved-config.json` | `340f9763873db840e80e5822755fdc29fb29fd0236ffb5e28a7e734feefdde14` |

## Stop

Independently review exact final evidence and scoped claims; commit/push and open a draft child PR
based on `fix/moss-computer-recovery`. Return bounded delayed-reload PASS or evidence-backed rejection
plus one next proposal. No automatic adoption, merge or issue close. Historical original-image canvas
root cause/image disappearance remain UNKNOWN. This proof transfers no rebuilt-image Firefox,
profile/replacement persistence, Ben manual/MacBook, Internet or integrated-owner acceptance.
