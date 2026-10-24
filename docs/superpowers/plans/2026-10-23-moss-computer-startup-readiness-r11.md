# Startup readiness: r11 exact launch packet

Task #3578 / parent #3577; same isolated branch/worktree `qualify/moss-computer-startup-readiness-r9`, draft PR #3598. Ben said “yea fix it” after r10's rejection. This authorises a bounded probe correction and one fresh reviewed attempt under the [r9 handoff](../handoffs/2026-10-23-moss-computer-startup-readiness-r9.md) and original startup handoff. Earlier rejections remain unchanged. Codex `/root` is the active automated finish operator; `/root/r9_evidence_review` performs independent read-only review and never authors fixes. Commit this exact packet and obtain exact-artifact acceptance before launch. No automatic second run, merge or issue closure.

## Admission, identity and exact image

Entry at21:30:18.841119 UTC passed: RAM25,478,639,616, root48,174,338,048 and data991,001,382,912 bytes; Moss running healthy and `/health` returned `{"ok":true}`. RAM/root floors8GiB, data30GiB remain mandatory. The exact adopted image was present. Within the ten-minute entry/preparation interval, later inspection returned explicit “No such image”, exit1. Cause is UNKNOWN; no image infrastructure investigation, retry, restart or reclamation. Preserve this present-to-absent observation. Independent review accepted it as the handoff's expected absent-image branch, rather than a failed load or wrong-identity assertion.

Fresh actual archive verification passed: retained `../moss-computer-reconstruct-r2/candidate-image.tar`, size1,026,041,856, SHA256 `48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`. Actual config identity and all seven actual layer payloads match Linux/amd64 adopted image `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`. Fresh independent PASS_RESTORE_READY21:37:26.232074 UTC was conditional on fresh floors and one exact load. Pre-load21:37:39.905998 UTC passed: RAM35,836,792,832, root47,919,431,680, data985,741,422,592 bytes; Moss healthy. One bounded load exited0; actual identity/platform/all seven layers matched afterwards. No rebuild, substitute, viewer upgrade or earlier acceptance transfer.

`readiness-r11`, sibling `../moss-computer-readiness-r11/`, exact container/network labels and reservation name were checked unused before creation. `devports claim moss-computer-readiness-r11` reserved5187. Fresh home/socket, unique marker and synthetic one-day CA/server/owner/foreign identities; earlier roots/homes/scripts/receipts/archive remain unchanged. Runner enforces fresh admission/healthy Moss immediately before watchdog/launch, followed by a positive first watchdog sample. Any failed admission ends this attempt without waiting or retry.

## Ranked hypotheses and bounded correction

R10 recorded `RFB 003.003`, `Too many security failures` and live TigerVNC loopback blacklisting; r7's earlier502 cause remains UNKNOWN. Before corrections, ranked falsifiable hypotheses were:

1. Greeting-only probes accumulate security failures. Complete initialization predicts no blacklist at restored access through the same sequence.
2. A protection-removal connection causes the failure. The request sequence/statuses and backend observations distinguish whether it reaches the backend.
3. An unrelated backend fault persists. It predicts failure despite complete initialization and should be captured in live guest/gateway diagnostics.

Static readback confirmed r10 guestTCP, UnixWS, gatewayWS and successful accessWS closed after greeting without client version/security/ClientInit/ServerInit. That is a definite probe defect; its role in the blacklist remains a hypothesis until live evidence. Shipped noVNC initialization code retained from the exact image confirms the RFB3.8 sequence. Do not disable or relax the blacklist or security protections.

The fresh private probes now exchange exact `RFB 003.008\n`, select None only if advertised (unchanged guest `SecurityTypes None`), require SecurityResult0, send shared ClientInit1 and consume bounded complete ServerInit before orderly closure. WebSocket parsing uses installed `ws`, buffers fragmented/coalesced binary messages, validates dimensions/pixel-format bounds and caps desktop name4096/buffer8192. A positive handshake has an absolute5s deadline (access6s); guestTCP4s after bounded connect. Failures reject readiness; malformed/refusal/authentication failure is never treated as success. GuestTCP runs inside the offline guest; host `ws+unix` reaches the actual mounted Unix socket; synthetic mTLS/exact Origin gateway observation follows.

Prelaunch protocol-contract fixtures are separate from live evidence. The actual copied r10 gateway/access call sites falsely reported success with zero completed initializations; retained red receipt/log demonstrate it. Corrected actual gateway, UnixWS and access call sites all complete fragmented initialization, while parser/guest regressions reject the retained r10 refusal and security failures. Parser tests also cover coalescing, exact client bytes, invalid dimensions, length limits, deadline and early close. These fixtures do not reproduce TigerVNC's blacklist or qualify any live gate; no fixture runs during proof. Fixtures/listeners/socket are closed before launch. R7's actual terminal call-site/window regression, Python AST, Node syntax and resolved Compose checks pass. No DB/foundation or broad install.

## Single proof and unchanged acceptance

Independent watchdog must be alive/healthy before Compose launch40s. Initial sampled isolation30s; guestTCP readiness45s, UnixWS30s, gateway30s, nominal1s observations and each command8s. Overall readiness operation120s bounds this sequence. Known refusal/not-yet-ready observations carry timestamps separately from instrumentation errors; second identical command error stops/rethinks. No hard assertion retry or readiness extension.

After complete positive readiness, retain all owner/foreign/missing-identity HTTP and WebSocket status assertions and exact Origin assertions. Run mTLS removal, byte-exact pristine restoration, Origin removal and final byte-exact pristine restoration, expected driver0/1/1/0 and exact intended negative signals. Every101 connection completes RFB initialization, including unexpectedly allowed wrong-Origin101 before the unchanged403 assertion fails. Controls timeout90s. Synthetic identities prove only this trial's access path; they do not establish Moss owner authentication.

Actual current synchronous noVNC UI/RFB connected predicates20s; visible/intersecting attached canvas at least100x100 and at least10 sampled colours12s. Fresh unique initially absent designated file receives exact unique bytes through actual viewer RFB keyboard input, followed by exact readback. Host only prepares/activates a terminal. Startup operation120s; installed Playwright/ws resolve from `~/Jarv1s/package.json`. No screenshots, intercepted responses, stubs or host-written marker in the proof. Initial/final sampled isolation, full IDs, actual mounts/protections and live cgroups are retained. On failure, bounded timestamped guest AND gateway live process/socket/log/config/upstream diagnostics precede teardown.

## Supervision and closure

Unchanged UID1000 offline guest/network none/Unix socket2CPU/4GiB/512PIDs; separate trusted Nginx bridge gateway0.5CPU/128MiB/32PIDs; loopback5187. Read-only roots, dropped caps, no-new-privileges/default seccomp/docker-default AppArmor, bounded tmpfs/logs. No devices/Docker socket/production mounts or browser-security weakening.

Watchdog exact fallback label `com.moss.proof=readiness-r11`, deadline1800s, heartbeat90s, nominal5s samples. Fail closed on measurement/log failure, RAM/root below8GiB, data below30GiB or home+socket reaching10GiB. Monitoring is not quota; host browser/daemon remain outside caps. Preserve stop intent/shared lifecycle lock, dead/zombie watcher rejection, exact-label emergency kill/verify even on lock/setup failure and recorded PID/start/group cleanup for browser/timeout descendants. Actively finish well before60min; never leave runtime unattended.

Record numeric operation/runner/watchdog/cleanup/port-release exits; never-run operations null. Close owned browsers/watchdog/containers/network/listener/reservation and ephemeral identities; retain all homes/archive/scripts/receipts. Failed cleanup/port release/residual runtime rejects PASS. Verify healthy Moss, obtain independent closure readback and exact final report/JSON/spec/ledger review, then commit/push and update draft PR. #3578/#3577 remain open.

Ben additionally requires Computer access in the Moss app AND browser, to watch Moss, take over and return control. Spec§21 records this future product requirement; no owner/session/AppShell implementation occurs here. PASS here is limited to startup/protected viewer/fresh input/exercised protections/closure. Active Firefox sandbox, clean profile flush, replacement persistence, idle sleep/wake, owner integration, Internet/download, installer/platform/manual/release and reusable proof-tool work remain deferred. No shipped product/app-map change or production/Sports/News/Direct On work.

## Exact private artifacts

All paths below are relative to `../moss-computer-readiness-r11/`. Only synthetic credential hashes are public; actual bytes are independently inspected. Manifest SHA256 `5537c3c2570856d4a7016068173ccfe2d1eca5349d788d3b8ef49329e06de8c6`.

| Artifact                                | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `.env`                                  | `843adc3e7d9ff9d00231994f43a3ad0727a2b169ae661b5d873aad577b79c650` |
| `access-check.mjs`                      | `8015f0b8a848c88bcbe3d9be7e70c7a429824c0987eb8ee0c10d2ca467476cd2` |
| `access-controls.py`                    | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`                          | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `client/ca.crt`                         | `b2868927eb0db7b33c8a010697b981bee0a0cec09183de01a0c1c4cc955ac381` |
| `client/foreign.crt`                    | `d5c30cfcad6beb1fe9827c88806813fc148c7c874f0e9cbbe9bcd3ded9abb621` |
| `client/foreign.key`                    | `f4c0231fd51a0b0ca2b97ac417b746e75a4c90d5540adb2d4f1beef3cc795527` |
| `client/owner.crt`                      | `3824ddccefb5198003f974ffec420d94f4702f1dc18738c9788bf84e91215918` |
| `client/owner.key`                      | `b4d1339fa4203d15933e65c0d1c77874560d4d6ca0523fd569a3afd6eb9a5df2` |
| `closure.py`                            | `3eb957b160bec7350d34c01ad213733190e846e4aef6c15e1bd2f4723c84fe40` |
| `compose.yaml`                          | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `diagnostics.py`                        | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `gateway/ca.crt`                        | `b2868927eb0db7b33c8a010697b981bee0a0cec09183de01a0c1c4cc955ac381` |
| `gateway/nginx.conf`                    | `f21f41333158ea294c67ae81f8aaea83a3ec08b999d22f6ae1de97dc48d39c70` |
| `gateway/server.crt`                    | `be8258ecb82e79371a568556df3dd04f8cfa34793fc388c575a01a68c4fbf334` |
| `gateway/server.key`                    | `c7c938b9fab6aaeb3e2bfa14320879cb269fffe5081f3df29ecfec00662c6d79` |
| `guest-contract-test.py`                | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`                          | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`                          | `69e498b951834c45605ca1af7a30d8f0964fe83317104700f0fdb3b866f65340` |
| `mutate.py`                             | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `pki/ca.crt`                            | `b2868927eb0db7b33c8a010697b981bee0a0cec09183de01a0c1c4cc955ac381` |
| `pki/ca.key`                            | `20c8265e79879b2afbc5cc1c6da29a996cdc6838573893d78029848ecbca6360` |
| `pki/ca.srl`                            | `1c7e141fb991076143689e18ce9564fedd0a5e898050d973fda0d59072b457dc` |
| `pki/foreign-ca.crt`                    | `bd8191a5e16e2b87cf5cc22a45b6431d34e9a8adfc31d077180827d7496cc175` |
| `pki/foreign-ca.key`                    | `065ebe822fed78dd0a23350ca3bd48578b1c89638bd2b9112251fff5f3097309` |
| `pki/foreign-ca.srl`                    | `b123a257b102218c69e14231461e8a8436b82179a56f98e0ddf5111517ab2cbe` |
| `pki/foreign.crt`                       | `d5c30cfcad6beb1fe9827c88806813fc148c7c874f0e9cbbe9bcd3ded9abb621` |
| `pki/foreign.csr`                       | `f3c7c32f13d86a1deaa71b287638aec100480b58a0e0c426dd5b134c946d5ab7` |
| `pki/foreign.ext`                       | `b332f2257d9f16c3c30d86527ca1b26ecb75bab6c60903c606b391b49d054453` |
| `pki/foreign.key`                       | `f4c0231fd51a0b0ca2b97ac417b746e75a4c90d5540adb2d4f1beef3cc795527` |
| `pki/owner.crt`                         | `3824ddccefb5198003f974ffec420d94f4702f1dc18738c9788bf84e91215918` |
| `pki/owner.csr`                         | `0191487c9ed17d0eb552e4886cae322e9f40005f82a9de56188d9520faf5fa5e` |
| `pki/owner.ext`                         | `b332f2257d9f16c3c30d86527ca1b26ecb75bab6c60903c606b391b49d054453` |
| `pki/owner.key`                         | `b4d1339fa4203d15933e65c0d1c77874560d4d6ca0523fd569a3afd6eb9a5df2` |
| `pki/server.crt`                        | `be8258ecb82e79371a568556df3dd04f8cfa34793fc388c575a01a68c4fbf334` |
| `pki/server.csr`                        | `068273ba9a153e0365cfa9a906cc21e14eaa0b9e3ccaacbb889bc06a434b3759` |
| `pki/server.ext`                        | `9108062f40624df782e1e00be7bcf754fb80737444f5cf236dc3f98c23739dfd` |
| `pki/server.key`                        | `c7c938b9fab6aaeb3e2bfa14320879cb269fffe5081f3df29ecfec00662c6d79` |
| `port`                                  | `8ea71daa43a276243fbf9ffa6f7a685d472e56687fa69bcdda78270a75022fb7` |
| `probe-regression.mjs`                  | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `proof.json`                            | `b69493f1bd8e97af54faf3e6bdad7ff9c749040d1e103772a3cb3a1b22ed284d` |
| `readiness-gateway.mjs`                 | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`                          | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `receipts/archive-verification.json`    | `e4ed0cd6a0f568844b5fd58871c0d5b55d4fc6dee89f5ac42c0596a58c880102` |
| `receipts/entry.json`                   | `3b6df3206188574dbfc69f0db581311eb6f3f28cf4a73889779134ce7b38185e` |
| `receipts/image-absence.json`           | `82d6f9a19e08891a00f749d1bf8a72aa25c08eb08e61e450b4d34a4ff52491bc` |
| `receipts/image-load-exit.json`         | `f6aa79be1c7595937e56f936ca49f438d2525c8ca206612d4675f6fb47d9d0ad` |
| `receipts/prelaunch-checks.json`        | `f6f7b62c56a2d51b3b134fd9ec0ec58d73721d75a241e31a2c1f57da98c880e2` |
| `receipts/probe-regression-latest.json` | `8042f5eea8200240087d93dbd99882958c26e797e1eefa4d58747a965d53ed9b` |
| `receipts/probe-regression-red.json`    | `261a2dfc252622e665df2929b6692482de20372f79358147d6630bb88e9aabbf` |
| `receipts/resolved-config.json`         | `ff164a34f9f8f0e4a7df3f7f53599dcabf773de4894c2974aafe66bef0934d4a` |
| `receipts/restoration-review.json`      | `88107f87811a3784368a9c0caf2288708edfa2dbef04b2de19f558bd1807e8f3` |
| `receipts/restored-image.json`          | `ba3bf02f08ca0567c1f85600def48f62634e2cd6debab353c1cc8e937c594ae7` |
| `rfb-contract-test.mjs`                 | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`                       | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                                | `1fbef6098ff8d3fdb2799a02f0992226c3ef1c696fc80ea30638cde84fed1294` |
| `startup.mjs`                           | `d226b0d0fb698963e9ffcf44cf403c611a66aa86cc5d4ea5e61683c0696d426e` |
| `supervise.py`                          | `dcbee08114ab0e6310a03ad9e1aaae022a7b1a6a878a9d1ba2c02977a9c9ca17` |
| `window-test.mjs`                       | `62598a202c418fa790566885b39c9b2cfe3f9cee76e2959926684b87c8ec9960` |
| `window.mjs`                            | `42699e01f2a2764c4ebd035248470c4b4780598b181aa4b8011cd3c59840897c` |
