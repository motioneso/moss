# Moss Computer: r12 sandbox and replacement launch packet

Task #3578, part of #3577. Dispatched by the [implementation handoff](../handoffs/2026-10-23-moss-computer-implementation.md), which supersedes historical integration exclusions. This packet authorises only the one offline prerequisite run; product integration is a separate candidate. Operator: Codex `/root`. Independent read-only reviewer: `/root/implementation_review`; no reviewer authors fixes.

## Admission and exact identity

Fresh entry 2026-10-23T21:57:23.873393Z passed: available RAM28,956,270,592, root47,273,586,688, data979,600,453,632 bytes. Moss running healthy; health returned ok:true. Floors remain RAM/root8GiB, data30GiB. Recheck immediately before launch; a failure ends this attempt without retry, waiting, reclamation, restart or host substitution.

New unused identity `persistence-r12`, private sibling `../moss-computer-persistence-r12/`, fresh empty home/socket, fresh one-day synthetic CA/server/owner/foreign keys, unique file/bookmark token. Reserved loopback port5184 via devports. Earlier roots are read-only evidence; preserve them. Exact adopted image is PRESENT: `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`, Linux/amd64, all seven layer identities match r11. No restore/load/rebuild needed. Unexpected absence before launch requires independent fresh archive/config/payload review before at most one exact load, never substitution.

## Exact sequence and predicates

Reuse corrected r11 complete RFB3.8 guestTCP/UnixWS/gateway/access handshakes and r7 current-window/error handling. Preserve current synchronous UI/RFB predicates, attached visible intersecting canvas>=100x100 and >=10 sampled colours. No screenshot, stubbing or response interception. Host prepares/activates terminals only; commands/bookmarks pass through actual viewer keyboard input.

1. Exact artifact hashes, fresh admission, independently alive watchdog with positive healthy first sample; bounded Compose launch40s and initial sampled isolation30s.
2. Complete backend/Unix/gateway readiness120s, unchanged protected access/mTLS-removal/Origin-removal/restoration checks90s, expected drivers0/1/1/0 and exact intended failure messages. Every101 finishes initialization. Byte-exact pristine config restoration required.
3. Persistence operation240s: actual current visible UI, initially absent unique designated file and Firefox profile DB; viewer creates exact file bytes and bookmark against packaged offline fixture. Rediscover active verified Firefox window at transitions; known pending observations are separate from command errors. Second identical command error stops. No failed hard assertion retry or increased deadline.
4. In second tab copy actual about:support over a fresh clipboard sentinel. Assert actual binary/profile, BPF/thread sync/content sandbox true and configured/effective level6; preserve User Namespaces=false. Read actual parent and file/web tab processes with extra filters beyond parent; explicit child visibility limitations, mandatory parent executable/environment. No disable flags/environment/security changes. Keep fixture tab alive. Clipboard setters redirect output to avoid inherited pipe retention.
5. Close Firefox through viewer UI; require actual process disappearance, absent/empty WAL and exact flushed SQLite bookmark/file state. On disposable copies first require pristine checker0, then file tamper/bookmark deletion checker1 at intended assertions. Require unchanged real file/main-DB hashes after controls.
6. Stop/remove/recreate desktop using fixed reviewed image and identical designated home. Record full distinct IDs, image, mounts, timestamps and operation exits. Before opening Firefox compare exact durable file/main-DB hashes. Explicit browser viewer reload, fresh visible current frame/input. Start Firefox blank; select actual bookmark through browser UI, require exact URL/title/file readback, fresh input and active sandbox again. Clean close/flush again.
7. Final sampled isolation/cgroups, active closure regardless of result. Bounded live guest AND gateway diagnostics before teardown on failure. No automatic second run.

Hypotheses: corrected r11 initialization avoids aborted-handshake probe effects (r10 trigger remains unproven); r7 rediscovery survives Firefox window transitions (r6 loss cause UNKNOWN); the retained-home replacement preserves cleanly flushed actual file/profile bytes (not yet accepted on this image). Each is falsifiable by the unchanged assertions above.

## Supervision, confinement and closure

UID1000 offline network-none guest through Unix socket;2CPU/4GiB/512PIDs; separate trusted bridge gateway0.5CPU/128MiB/32PIDs and loopback5184. Read-only roots, dropped caps, no-new-privileges/default seccomp/docker-default AppArmor; bounded tmpfs/logs. No devices/Docker socket/production mounts/browser sandbox weakening. Synthetic identities do not establish Moss ownership. Offline networking qualifies no Internet egress.

Independent watchdog before launch: exact fallback label `com.moss.proof=persistence-r12`, monotonic1800s deadline,90s heartbeat, nominal5s samples, fail closed on measurement/log failure/floors or home+socket reaching10GiB. Monitoring is not quota; host browser/daemon outside caps. Preserve stop-intent/shared lifecycle lock, dead/zombie watcher rejection, emergency exact-label kill and verify even on lock/setup failure. Actively supervise and finish well before60min.

Runner records all operation/runner/watchdog/cleanup/port-release exits; null for unrun. Timeout descendants and browsers use recorded PID/start/group identities. Close browser/watchdog/guest/gateway/network/listener/reservation/ephemeral keys; retain homes/archive/scripts/receipts. Any residual runtime, failed cleanup/release or unhealthy Moss rejects PASS. Independently verify closure and exact final evidence. Scope pass only to observed active sandbox/clean file-profile replacement; no sustained-fit, arbitrary outage, manual MacBook/platform, idle lifecycle, owner integration, Internet/download or release acceptance. No production changes, merge or issue close.

## Static checks and exact artifacts

Python AST and Node syntax passed. Actual persistence terminal call-site/window regression, RFB contract, guest contract and copied probe regressions all exit0. Initial window-regression invocation found a stale fixture target (`startup.mjs` absent); redirected regression to the actual `persistence.mjs` call site and passed before runtime. No product/runtime assertion was retried. Resolved Compose and installed Playwright/ws were inspected; no dependency installation.

Manifest SHA256 `ec8ffb245003175a3e83727872e4a807e89cf92a428e81dd367b3094cc057e43`. All paths relative to the new private sibling. Runtime must hash-match this committed packet and actual manifest before execution.

| Artifact                                | SHA256                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| `.env`                                  | `6df635acd9dc138528d5dbf1a4557737e9ca0558be4d6e649f549fe3176db4cb` |
| `__pycache__/guest-rfb.cpython-312.pyc` | `bd60a8e85d213c0a7e4d32468bb65fa194fbdfc6d5d0a801cee74291b4e0c80f` |
| `access-check.mjs`                      | `7c3873522958aea929165f5c479455fb970d7018b6236c668204b2dd206d65f9` |
| `access-controls.py`                    | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`                          | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `check-state.py`                        | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `client/ca.crt`                         | `50ccfd4190026cef258523d612bc665f8786dca815b2564490a2f299c66ad68b` |
| `client/foreign.crt`                    | `0f38ea6fd416ec3460dfbc680d193a7c7edc608590b774017ac4f36a985b33e5` |
| `client/foreign.key`                    | `6ea7dae09c6a450d4d77c13ee77b264a61328d61e01ec43f8b3da20016e01a6d` |
| `client/owner.crt`                      | `ecc61157d4319139ac1a3303f683142ea0b23c9a1a19f2b855b9359f58a37008` |
| `client/owner.key`                      | `a1e6c3230bbb3e1ba388f3240b3a5d29f712e3c41582094ebf213ade8c1d1a10` |
| `compose.yaml`                          | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `controls.py`                           | `c9e56dc2a2502a3fd5bab625e9549a42c767f3a16a91a75a8c484059c44ade18` |
| `diagnostics.py`                        | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `gateway/ca.crt`                        | `50ccfd4190026cef258523d612bc665f8786dca815b2564490a2f299c66ad68b` |
| `gateway/nginx.conf`                    | `dc290b02ea1f4bf848c033c73deb3efae12471e4983a9a703846c9d2b3b60a54` |
| `gateway/server.crt`                    | `595299c46f80cae097430d7f471b69a627e102943ecfd819def358a0a4fa6b95` |
| `gateway/server.key`                    | `6e3e1a9ca0fb83163c4f60829b05aa913c518cc7936b45c802655c689ed7c754` |
| `guest-contract-test.py`                | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`                          | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`                          | `9377244a2b4be72b247ae72abc80a25738a79033cc700ffa9af9a8a110b892c9` |
| `mutate.py`                             | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `persistence.mjs`                       | `c79af72232be15aea06ec340972ae2150f4a8f8f04b3f373bbc6bfc39cdac210` |
| `pki/ca.crt`                            | `50ccfd4190026cef258523d612bc665f8786dca815b2564490a2f299c66ad68b` |
| `pki/ca.key`                            | `d8ce4a59af72fd03f6526bff5616857ed95201ee430bcfb091c67901c40486a4` |
| `pki/ca.srl`                            | `233eb2b2fabc9f437e8cff0d6f385f7b8ae8f533c76fc0cc3df7bfe09c5b58fc` |
| `pki/foreign-ca.crt`                    | `64628134072559c9e34191230c3d1f8e76b2c2b0c5a5565ad51f3997597e6f9e` |
| `pki/foreign-ca.key`                    | `8ece6dd37a085c664dd9a861aa4b38746f1a73c86abfa925d9608569c7f0a672` |
| `pki/foreign-ca.srl`                    | `edd956c2b48e3bfe0866af728fbac8155eda6eee9e8ba81d6cbb72e201885a11` |
| `pki/foreign.crt`                       | `0f38ea6fd416ec3460dfbc680d193a7c7edc608590b774017ac4f36a985b33e5` |
| `pki/foreign.csr`                       | `fa94819385fe6530d703522dcf58de030774a9009597e9942bf1ecf46db91242` |
| `pki/foreign.ext`                       | `b332f2257d9f16c3c30d86527ca1b26ecb75bab6c60903c606b391b49d054453` |
| `pki/foreign.key`                       | `6ea7dae09c6a450d4d77c13ee77b264a61328d61e01ec43f8b3da20016e01a6d` |
| `pki/owner.crt`                         | `ecc61157d4319139ac1a3303f683142ea0b23c9a1a19f2b855b9359f58a37008` |
| `pki/owner.csr`                         | `1df88b6fd1fecb5f0fb3a5e0e3cf3b0bf3ce9846d8baacef28bb05daad23ae1b` |
| `pki/owner.ext`                         | `b332f2257d9f16c3c30d86527ca1b26ecb75bab6c60903c606b391b49d054453` |
| `pki/owner.key`                         | `a1e6c3230bbb3e1ba388f3240b3a5d29f712e3c41582094ebf213ade8c1d1a10` |
| `pki/server.crt`                        | `595299c46f80cae097430d7f471b69a627e102943ecfd819def358a0a4fa6b95` |
| `pki/server.csr`                        | `c0c441eb55c8771857081d1b5520d7ecb3e953d590b289b1408ecabad5a49420` |
| `pki/server.ext`                        | `2f131f1ee4fe7ef196c0b339c8c458e56b46a5d0cb90b90c033274b0b95c7da8` |
| `pki/server.key`                        | `6e3e1a9ca0fb83163c4f60829b05aa913c518cc7936b45c802655c689ed7c754` |
| `port`                                  | `fb858fca07e78f8be68e88b42bc5101c8b2b4e87e0bcf164247e8920858aa6b7` |
| `probe-regression.mjs`                  | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `process.py`                            | `2ede92bae11e2fca8ccf611534d27bbfaf08311e63ed13e06732a38d92f9f5c7` |
| `proof.json`                            | `c031297e3ea6ffdbde412dbf88091ee4aea7a5f4b700db8dc3b0861e725bff37` |
| `readiness-gateway.mjs`                 | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`                          | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `receipts/access.json`                  | `05c04d0f4a8fab8466577ac27b857eed13ae23c87c1bbca6797c71e1af60a8a5` |
| `receipts/entry.json`                   | `ec55d2ce505fe04f549c0bb7498a51cdd0f8fb6f1692a27db4af98f0d6bff915` |
| `receipts/guest-regression.log`         | `87770c9b9795ca3690f877fa62b4b6a8443941d359a14f6d402dcfd614deeb4b` |
| `receipts/image.json`                   | `07311f5865282cb91a600fc4525f6a807b5c7ec5960edb9d5187ec5865922b6b` |
| `receipts/probe-regression-latest.json` | `e43bdaa2c56b34acae43311ae6f4e32d019951a459b9f8db78894aff1fc41c44` |
| `receipts/probe-regression.log`         | `e0d2a51c8e7f39f325f72f3a73ddae2c4f89110b53937a786073ada2d8460e52` |
| `receipts/resolved-config.json`         | `8c2f30508e7e631112286b453fb059ae70332f7fe0ea362101d62fdc954845e5` |
| `receipts/rfb-regression.log`           | `cd041d8820ab4bdff4d637b4c13659610a754f254ae3e81c404641fee2f7ab26` |
| `receipts/window-regression.log`        | `0a5ae1758810abd3be93648b31daa04b8ad1847c830f6331fab694e4e5e2a8df` |
| `rfb-contract-test.mjs`                 | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`                       | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                                | `3c3bd5fff2c60d4b1159122e11fb310186b443ff16e7ca69180f42ead1d68b85` |
| `supervise.py`                          | `3310c50ba98898ea1d362baeb66dc679278ac6d3d4342cd958b4c03cd156ff99` |
| `window-test.mjs`                       | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `window.mjs`                            | `42699e01f2a2764c4ebd035248470c4b4780598b181aa4b8011cd3c59840897c` |
