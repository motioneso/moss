# Adopted-image sandbox and replacement persistence: r6 launch packet

Task #3578 / parent #3577; follows merged #3579 and the
[operative handoff](../handoffs/2026-10-23-moss-computer-persistence.md).
Codex `/root`, session `01a16981-6c86-7df1-82ab-397cf5db2e90`, is active finish operator.
One supervised run only, after this packet is committed and independently reviewed against exact
private artifacts. Reviewer has no authorship. No product, owner integration or idle-sleep implementation.

## Entry and exact identity

Fresh bounded entry at16:51 UTC: Moss healthy, Docker default; available RAM19,916,611,584 bytes,
root free9,003,347,968 and data free1,033,569,468,416. Gates passed. Exact image initially absent.
Retained archive size1,026,041,856 and SHA256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9` verified, including actual
config and all seven layer digests. Single bounded docker load returned0. Its wrapper returned1
because the expected ID literal was mistyped after load; preserved as an instrumentation failure.
Direct inspect then matched the independently verified config digest exactly; no second load.
At16:54 UTC root free8,995,782,656 bytes, only405,848,064 above the8GiB floor. Recheck by watchdog
before launch and throughout. No space reclamation, restart, prune or infrastructure repair.

Image `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`, same adopted
Linux/amd64 noVNC1.3/Websockify0.13/TigerVNC1.12/Xfce4.18/Firefox ESR153.5.1.
Fresh run `persistence-r6`; private sibling `../moss-computer-persistence-r6/`, independent home/socket,
synthetic one-day CA/server/owner/foreign identities; reserved loopback5188. Prior homes/archive untouched.
Public paths use canonical `~/Jarv1s`; private resolved paths/keys are not committed.

## One real-path acceptance sequence

1. Verify exact artifact hashes. Start independent supervisor, confirm alive and first healthy sample;
   only then Compose launch. Check actual image/user/default security/resource/mount/network controls.
   Current-image access matrix must pass; unchanged assertion must fail with mTLS removed and with
   exact-Origin protection removed, then pass with byte-exact restored gateway config.
2. Installed Node Playwright/ws from `~/Jarv1s/package.json`; no broad install or screenshots.
   Fresh host browser, actual noVNC UI/current RFB synchronous readiness. Require current RFB canvas
   attached/visible/intersecting viewport, >=100x100 and >=10 sampled colours. Host prepares/activates
   terminal; commands traverse actual RFB keyboard. Initially absent unique designated file is written
   through viewer and read back exactly. Fresh profile database must be absent before first launch.
3. Launch real `firefox-esr --no-remote --profile /home/desktop/.mozilla/firefox/moss` with unique
   fragment on packaged offline fixture. Verify actual Firefox window title and copied address.
   Real Ctrl+D/name/Enter creates unique bookmark. Keep fixture tab alive; second tab about:support
   must copy over a fresh clipboard sentinel, assert actual binary/profile, Seccomp-BPF and thread
   synchronisation true, content sandbox true and effective level6. Preserve User Namespaces=false.
   Capture actual parent/content arguments, executable/status and sandbox-related environment;
   require actual file/web tab processes (excluding RDD/socket helpers) with additional seccomp filters beyond Firefox parent, no disabling
   overrides, including zero sandbox levels. Parent identity/environment mandatory; unreadable child exe/environment fields are recorded as visibility limits, never passing defaults for core status/filter observations. These diagnostic observations do not certify universal browser security or namespaces.
4. Close Firefox via viewer Alt+F4/confirmation; poll actual parent disappearance. Read-only SQLite
   and exact file check require unique URL/title row and bytes. Retain hashes. On separate disposable
   copies, first require the identical check to pass, then alter file or delete exactly one existing bookmark row and require same check to exit1 at expected assertion. Require absent/empty WAL before read-only immutable checks/copies; no unflushed profile acceptance.
   Recheck real home hashes unchanged; controls never edit it.
5. Stop and REMOVE exact guest, record numeric exits/timestamps and require old full ID absent.
   Create new guest with distinct full ID, same exact image and resolved designated home. Gateway
   remains. Before Firefox reopens, require identical designated-file and places.sqlite hashes.
   Explicit viewer reload, current RFB/frame assertions and new keyboard marker qualify input.
6. Launch fresh Firefox at about:blank with same actual profile. Firefox address-bar `* token`
   bookmark-only search must navigate to exact persisted fixture URL; assert address and fixture
   window title. Viewer terminal reads retained file and host readback verifies bytes. Repeat active
   sandbox/about:support/process evidence. Cleanly close Firefox and rerun SQLite/file assertions.
   Check current replacement isolation controls. Acceptance requires every sequence step.

Ranked falsifiable hypotheses before any fixes: (1) designated-home reuse preserves exact flushed
file/profile bytes; (2) real bookmark creation/clean flush is necessary and red controls detect loss;
(3) added Firefox content filters and about:support substantiate active sandbox on this image;
(4) fresh current RFB/frame/input is required after replacement; (5) resource gates can independently
reject. Preserve material failures; two identical failures stop/rethink. No image/security changes.

## Bounds and active finish

UID1000 offline guest network none, Unix socket,2CPU/4GiB/512PIDs. Separate trusted Nginx bridge
0.5CPU/128MiB/32PIDs, synthetic mTLS and exact Origin, loopback only. Read-only roots, dropped caps,
no-new-privileges/default seccomp/docker-default AppArmor, bounded tmpfs/rotated logs; no devices,
Docker socket or production mounts. Sampled network tests are not universal isolation certification.

Supervisor fallback exact label `com.moss.proof=persistence-r6`, deadline1800s, heartbeat90s,
nominal5s samples. Fail closed on measurement/log failure, RAM/root free below8GiB, data below30GiB,
home/socket reaching10GiB. Monitoring is not quota. Host browser/daemon outside guest caps.
Runner bounds launch40s/access90s/harness420s and actively cleans up in finally. Replacement mutations
check watchdog alive/no stop receipt and acquire a shared lifecycle lock. Supervisor publishes stop intent before acquiring that lock, drains in-flight mutations and always kills/verifies residual exact-label services. New starts after intent fail. No unattended runtime, finish well before60 minutes.

Record exact host-browser PID/start-time/group identities after launch and before close. Runner captures descendants before killing a timed-out harness, stops only owned process identities/groups and requires their absence; cleanup/port-release failures reject PASS. Capture full guest and gateway IDs, operations/exits/timestamps, cgroup observations and numeric
supervisor exit. Close host browser and actual Firefox, stop supervisor/services, remove only owned
containers/network/listener/reservation and fresh synthetic keys. Retain new/prior homes and receipts.
Require no owned containers/network/listener and healthy Moss. Independent final review, sanitised
committed/pushed evidence and draft PR update; no merge, issue close or additional runtime.

Idle sleep is a future product requirement only. No owner/session/UI/download/Internet/platform/
installer/manual-MacBook acceptance. Prior image acceptance cannot fill adopted-image gates.
Historical image disappearance and Herdr incident causes UNKNOWN. News/Direct On gates stay separate.

## Readiness revision

Initial exact review rejected `fa461517` before any runtime: wrong content-process classification,
zero-level environment exemption, missing pristine-copy controls/WAL handling, shutdown race,
unchecked cleanup exits/host-browser timeout cleanup, and packet formatting. Revised bytes below
address those findings and require fresh independent acceptance; prior hashes remain in git history.

## Exact artifacts

Hashes below resolve in the private sibling; `.env`/resolved config are reviewed privately.

| Artifact                        | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `compose.yaml`                  | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `.env`                          | `023160f9321189a06bf9181ab7e4e6453b5aea0b7c624099ae1e42051015e265` |
| `gateway/nginx.conf`            | `285d0b3a705aba8dffa751614cd3a0aa7b12a34b75e71e89aaab5f0dec2ca21e` |
| `supervise.py`                  | `0d0a21211797de384bbb9d7545e17d80415c0d5fa841396401c014857b27f760` |
| `access-check.mjs`              | `2ebc9f93191006a891aee949b5b69829d92fa2edf0bf62f869f4e41673029512` |
| `access-controls.py`            | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `isolation.py`                  | `12ab9f1e8fd47711e4d191d230d1d3b42f8315aac6a54f833b1b4c8830ccfece` |
| `process.py`                    | `2ede92bae11e2fca8ccf611534d27bbfaf08311e63ed13e06732a38d92f9f5c7` |
| `check-state.py`                | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `controls.py`                   | `c9e56dc2a2502a3fd5bab625e9549a42c767f3a16a91a75a8c484059c44ade18` |
| `persistence.mjs`               | `abea703b9bcfcada5deac5f6656eab5cc4001972b259699070e99aa46bfe0408` |
| `run.py`                        | `47bbc7921cc0b3c535918d1064ceb546b44c895f9cd1894755057f281b0a5cfb` |
| `proof.json`                    | `4539aad539382e4e825901464eeba01dd874891739887424d4d57164ed23f1d7` |
| `receipts/resolved-config.json` | `24d53d1cfe1de0e117baaef4b60ec66ec88b22b2085dba12a2ea14e87daa6a7d` |
| `mutate.py`                     | `c4a0ad67b0f9c62069adecda13b46b7e7b41b34ff24c3bd3d99ee618a19b4874` |
