# Computer viewer r15: instrumented diagnosis and persistence

Task #3578 / parent #3577; owner integration #3605. Operator Codex `/root`; independent read-only
reviewer `/root/viewer_review`. Ben directly instructed continued repair, superseding the prior
unsupported-repair stopping decision in the [diagnostic plan](2026-10-23-moss-computer-viewer-diagnosis.md).
No causal viewer repair is claimed before this run. This attempt records the missing browser boundary
while preserving the entire r12 acceptance sequence and original deadlines.

## Exact identity and safeguards

Private sibling `../moss-computer-viewer-r15/`; fresh empty home/socket, unique proof token and fresh
one-day synthetic CA/server/owner/foreign identities. Port 5180 was claimed as `computer-viewer-r15`.
Exact adopted image `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf` only.
Archive size/checksum, config and all seven actual payload layers were freshly verified by operator
and independently reviewed. One exact load was conditionally accepted after completed external Moss
deployment and requires passing fresh pre-load admission and post-load identity/platform/layers.

Historical r13 admission found Moss stopped; Ben explicitly authorized starting the existing container.
A separate external production deployment then replaced it during r14 pre-load admission, which failed.
Neither r13 nor r14 loaded the image or launched a desktop; keys/reservations were closed and failures
preserved. No production rebuild/deployment was performed by this operator. Current Moss health is a
fresh r15 requirement; earlier failures are never converted into passes.

Guest UID1000/network none/Unix socket, 2CPU/4GiB/512PIDs; separate trusted gateway
0.5CPU/128MiB/32PIDs, loopback5180. Read-only roots, dropped capabilities, no-new-privileges/default
seccomp/AppArmor and bounded tmpfs/logs. No production mounts, devices, Docker socket, substituted
image, sandbox relaxation or Internet egress. Synthetic mTLS does not qualify product ownership.

## Sequence and acceptance

1. Verify all immutable manifest bytes, then fresh prelaunch floors RAM/root >=8GiB,data>=30GiB
   and healthy Moss. Independent alive watchdog before launch: exact fresh label, 1800s maximum,
   90s heartbeat, nominal 5s sampling, fail closed on measurement/log/floor failure or home+socket
   `>=10GiB`; preserve lifecycle lock, stop intent, zombie rejection and exact emergency kill.
2. Existing isolation and complete guestTCP/UnixWS/gateway RFB3.8 readiness (120s), then unchanged
   protected access/removal/restoration drivers (90s), expected 0/1/1/0 and intended negative-control
   messages. Restore pristine gateway bytes exactly before browser acceptance.
3. Chromium fresh context, original 1280x1800 viewport and client certificate. Diagnostic listeners
   attach before navigation: startup rejection, console/pageerror/request failure, WebSocket/CDP
   handshake/error/close; snapshot actual UI/RFB/DOM/settings after import, connection and failure.
   Nginx diagnostic access records method/path/status/upgrade/client verification, bounded by Docker
   logs. A real full-UI synthetic-mTLS upstream-502 control already verified the diagnostic module;
   that is initialization/diagnostics evidence only, not desktop acceptance.
4. Original current connected UI/RFB assertion (20s), attached intersecting nonblank frame with
   at least 10 sampled colours (12s), and fresh viewer-keyboard file/readback. Actual Firefox URL/bookmark
   through viewer input, active about:support and actual content-process sandbox filters, clean UI
   shutdown/profile flush, file/bookmark negative controls, exact distinct desktop replacement on
   the same home/image, unchanged durable hashes before reopening, fresh connected UI/frame/input,
   bookmark-only search and reopened exact persisted URL/file, sandbox and clean close again.
   Existing persistence runner bound remains 240s. No stubs/interception replace real acceptance.
5. Failed hard predicates stop this attempt; retain browser/backend observations and close resources.
   No assertion retry, deadline increase or admission resampling in this packet. A causal correction
   needs separately identified artifacts and review under Ben's continued-diagnosis instruction.
6. Capture isolation/cgroups and bounded failure diagnostics; close browser/watchdog/guest/gateway/
   network/listener/reservation and ephemeral keys, retaining homes/archive/scripts/receipts. Check
   actual watchdog reason (`operator closure` + `NO_RUNNING_PROOF_CONTAINERS`) and every sample;
   exit0 alone never grants PASS. Independently verify exact-label/process/PID-start/listener/keys,
   healthy Moss and exact final evidence. Publish sanitized results, PASS only for observations and
   NOT_RUN for unreached gates. No sustained-fit/product-ownership/Internet/platform/lifecycle claim.
   No merge, deployment or issue closure.

## Exact immutable inputs

Manifest SHA-256 `72e58fcb0a9befc9dfea0deceb735d1584b5f337dbde2bf84b4367c532464d01`. Paths are relative to the private sibling. The manifest excludes mutable
receipts and its own file. Runner verifies these exact bytes before fresh admission. Independent
acceptance must identify this committed packet and actual manifest before any desktop launch.

| Artifact                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `.env`                   | `2b2f5ea8dc24788355aa352f90eee39a9029abfdf6c8855dc6a92a26a462f192` |
| `access-check.mjs`       | `1b4256f45e2ea2b521205f1239872d9b0512dc91e3dd356989c8665e22e8eeae` |
| `access-controls.py`     | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`           | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `check-state.py`         | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `client/ca.crt`          | `3f0ef6dae083ff0ff37c658726d85a21e749b06a2e48ff7e0e671b458e2a07e1` |
| `client/foreign.crt`     | `8aadaf28cf9831014d380b9535be7b24e6b08a56e263a9fac8b41376e6ed0b5a` |
| `client/foreign.key`     | `0ad6d800cb5a7047201f2aa229943712edff2de40d8520757580866324fdaf77` |
| `client/owner.crt`       | `f0a52bafd20a657bebc20f8900467466528f6bdc4402565e2d847d1d6684cf74` |
| `client/owner.key`       | `34f663e1b3605c3fdd9d9050570ace976e5e42a10a5a75d90579711aeeb67396` |
| `compose.yaml`           | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `controls.py`            | `c9e56dc2a2502a3fd5bab625e9549a42c767f3a16a91a75a8c484059c44ade18` |
| `diagnostic-check.mjs`   | `19bb376aa0db95a70658851ff1722b270bc7b713ded9f112f249438e1ef02223` |
| `diagnostics.py`         | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `gateway/ca.crt`         | `3f0ef6dae083ff0ff37c658726d85a21e749b06a2e48ff7e0e671b458e2a07e1` |
| `gateway/nginx.conf`     | `931f92b1b0f7265b430bdbf1c130663de751dfec7192588cf0ab97e203d2f431` |
| `gateway/server.crt`     | `a474af0549a6d3ed98c691de031948edbf2b610b66cb22863744f54731672c3a` |
| `gateway/server.key`     | `22346cf043464acdcb72e6f1284887dadaca6965c500be28f9b415b95b4c2e67` |
| `guest-contract-test.py` | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`           | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`           | `7689f39e033d8d45d48c190737d2d0ee6233864ee1d5984e45fbcd29fd79263d` |
| `mutate.py`              | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `persistence.mjs`        | `e56ffb84b3a4f31453ac9fc628caed8d47fcd1a7802858b28bac2fd5416bdada` |
| `pki/ca.crt`             | `3f0ef6dae083ff0ff37c658726d85a21e749b06a2e48ff7e0e671b458e2a07e1` |
| `pki/ca.key`             | `d27f4d09ddb13f13085f672f5abad88d9a6ce7596e7b77cf23f9be02f8218fae` |
| `pki/ca.srl`             | `e93c4c40c97869ea92476b237b5f5946f0961e8a24cac97af3562f199f951228` |
| `pki/foreign.crt`        | `8aadaf28cf9831014d380b9535be7b24e6b08a56e263a9fac8b41376e6ed0b5a` |
| `pki/foreign.key`        | `0ad6d800cb5a7047201f2aa229943712edff2de40d8520757580866324fdaf77` |
| `pki/owner.crt`          | `f0a52bafd20a657bebc20f8900467466528f6bdc4402565e2d847d1d6684cf74` |
| `pki/owner.csr`          | `1fc21b3deeca7f98f2bdc649f20ca04bebfde375c5c52736ef158ef4e502fc48` |
| `pki/owner.ext`          | `0f47ccf77f8edd06ce567b7aab6ef3f88704863b73d22844b7a749c34f4a4506` |
| `pki/owner.key`          | `34f663e1b3605c3fdd9d9050570ace976e5e42a10a5a75d90579711aeeb67396` |
| `pki/server.crt`         | `a474af0549a6d3ed98c691de031948edbf2b610b66cb22863744f54731672c3a` |
| `pki/server.csr`         | `d031b0d21670ed3140857e96d3a0a03010ce9696778395790efa0c201f6d85b2` |
| `pki/server.ext`         | `4836947f5aa394d56b21a362d500564a85f988432985651b1de858296e882e6f` |
| `pki/server.key`         | `22346cf043464acdcb72e6f1284887dadaca6965c500be28f9b415b95b4c2e67` |
| `port`                   | `b5a2658a8fd3e619fdd6f9f86016b2cd7542889e786faa247fef53c3e3a38ae6` |
| `probe-regression.mjs`   | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `process.py`             | `2ede92bae11e2fca8ccf611534d27bbfaf08311e63ed13e06732a38d92f9f5c7` |
| `proof.json`             | `a4bc7f30d456cf0a1ce5273a0de2913cd6eabb8c802047d03de1c750d48569b6` |
| `readiness-gateway.mjs`  | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`           | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `rfb-contract-test.mjs`  | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`        | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                 | `4be7a499852f84b34723b2586676d028a3524a634a1681d6ccb45c57a696daa4` |
| `supervise.py`           | `cd1390eff19c7630bc9b79e540551e812acb6ad159431cb5054f2a742280024e` |
| `viewer-diagnostics.mjs` | `f4bf0c9d13ab43d2bdb94999a1560ea51329f2c85c0460cf54ea387332ff049b` |
| `window-test.mjs`        | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `window.mjs`             | `42699e01f2a2764c4ebd035248470c4b4780598b181aa4b8011cd3c59840897c` |
