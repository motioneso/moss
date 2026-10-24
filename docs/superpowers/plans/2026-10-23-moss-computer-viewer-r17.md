# Computer viewer r17: instrumented diagnosis and persistence

Task #3578 / parent #3577; owner integration #3605. Operator Codex `/root`; independent read-only
reviewer `/root/viewer_review`. Ben directly instructed continued repair, superseding the prior
unsupported-repair stopping decision in the [diagnostic plan](2026-10-23-moss-computer-viewer-diagnosis.md).
No causal viewer repair is claimed before this run. The observed watchdog first-sample race is repaired. This attempt records the missing browser boundary
while preserving the entire r12 acceptance sequence and original deadlines.

R16 passed real current UI/RFB, a 1280x800 attached frame with 346 colours, fresh viewer-keyboard
file/readback, Firefox URL/bookmark input and active about:support level6. It stopped before clean
shutdown at the process classifier's flattened-argv mistake. Its failure and independent closure
are preserved; it establishes neither complete sandbox nor persistence acceptance. R17 normalizes
only exact known Firefox single-argument content-process titles, retaining raw argv and all original
parent/profile/executable/type/name/environment/seccomp/added-filter requirements. The regression
replays actual r16 rows: exact old classifier fails, all five corrected real tab rows pass; removed
added filters, helper-only processes, wrong profile and sandbox-disable controls fail. No sandbox
assertion is removed or weakened. A fresh real run must still pass every original predicate.

## Exact identity and safeguards

Private sibling `../moss-computer-viewer-r17/`; fresh empty home/socket, unique proof token and fresh
one-day synthetic CA/server/owner/foreign identities. Port 5180 was claimed as `computer-viewer-r17`.
Exact adopted image `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf` only.
Archive size/checksum, config and all seven actual payload layers were freshly verified by operator
and independently reviewed. The one exact r15 image load passed fresh pre-load admission and post-load identity/platform/layers.
The adopted image must still be present unchanged; no additional load is authorized by this packet.

The r15 runner passed admission but failed before desktop launch on its empty watchdog log race.
Independent closure passed. A guarded first-sample helper now waits for a complete JSONL record
within the original 10 seconds and rejects exited/stopped/malformed/unhealthy monitors. The
regression observes the exact old code fail, delayed/partial completion pass, and seven failure
cases reject, plus the actual runner call-site assertion. An initial test fixture omitted the
`json` binding; that fixture error was corrected before the observed red/green result.

Historical r13 admission found Moss stopped; Ben explicitly authorized starting the existing container.
A separate external production deployment then replaced it during r14 pre-load admission, which failed.
Neither r13 nor r14 loaded the image or launched a desktop; keys/reservations were closed and failures
preserved. No production rebuild/deployment was performed by this operator. Current Moss health is a
fresh r17 requirement; earlier failures are never converted into passes.

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

Manifest SHA-256 `4abcd8548d5358547292baaae135434b9267e1eee8ba6658b0bffb7d09c7b457`; 52 immutable inputs, excluding receipts and manifest itself.

| Artifact                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `.env`                   | `d3e980ee1d39304ff1bf7043c143686796341f43a08f3b60e9f1086ed55370ea` |
| `access-check.mjs`       | `4f6941a4b6ca54e7c4b18f1ff4d9695458f0412ca05a0ae961e372bc397932c1` |
| `access-controls.py`     | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`           | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `check-state.py`         | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `client/ca.crt`          | `50a5b1b290d641f75a0cc445ae64a0832b23cecaf97bf39d73a163ab0612c249` |
| `client/foreign.crt`     | `dfb216c60f8431d1e094081b7991af8ef529d68740c7cf2c47ac32898538d7ed` |
| `client/foreign.key`     | `ccce55f31ec62bea606a765d204537d6a7c12ff1a17d85d8cca89dc7f9364890` |
| `client/owner.crt`       | `98c9d1ae237d43dabbdcd91dbbf83121e8854105bd905070c4ecde220b5f8b59` |
| `client/owner.key`       | `d43685a5e3a0c6fc520ec2a4f8c6e714bdb85a4fc600cf3f24fedfdcfc85038c` |
| `compose.yaml`           | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `controls.py`            | `c9e56dc2a2502a3fd5bab625e9549a42c767f3a16a91a75a8c484059c44ade18` |
| `diagnostic-check.mjs`   | `19bb376aa0db95a70658851ff1722b270bc7b713ded9f112f249438e1ef02223` |
| `diagnostics.py`         | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `gateway/ca.crt`         | `50a5b1b290d641f75a0cc445ae64a0832b23cecaf97bf39d73a163ab0612c249` |
| `gateway/nginx.conf`     | `931f92b1b0f7265b430bdbf1c130663de751dfec7192588cf0ab97e203d2f431` |
| `gateway/server.crt`     | `91d812ca77ced38220d9adc9366bacefe75310e5681c8efd65b7c1f9dee21d78` |
| `gateway/server.key`     | `7f48b90119937ecae72c92963b56e83dc10ff3eeb04caadd802888832feecd04` |
| `guest-contract-test.py` | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`           | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`           | `5b39a1ecec5b6e5c515b4a0f113e322e731a8a8d22eda636b8a9b1e0aa2f345b` |
| `mutate.py`              | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `persistence.mjs`        | `e56ffb84b3a4f31453ac9fc628caed8d47fcd1a7802858b28bac2fd5416bdada` |
| `pki/ca.crt`             | `50a5b1b290d641f75a0cc445ae64a0832b23cecaf97bf39d73a163ab0612c249` |
| `pki/ca.key`             | `36d6e6f86a1d730c2676de1195fa32d0578e108026590eed8a0cd8379d1061d5` |
| `pki/ca.srl`             | `2b708e1a620659ca231b7b9c61bf310cd462d85aed99022815cbb35fe2a03ab2` |
| `pki/foreign.crt`        | `dfb216c60f8431d1e094081b7991af8ef529d68740c7cf2c47ac32898538d7ed` |
| `pki/foreign.key`        | `ccce55f31ec62bea606a765d204537d6a7c12ff1a17d85d8cca89dc7f9364890` |
| `pki/owner.crt`          | `98c9d1ae237d43dabbdcd91dbbf83121e8854105bd905070c4ecde220b5f8b59` |
| `pki/owner.csr`          | `dbfde677259556fd30a91d4c17477f3843ae3f8a239965899c92c9de29896d5b` |
| `pki/owner.ext`          | `0f47ccf77f8edd06ce567b7aab6ef3f88704863b73d22844b7a749c34f4a4506` |
| `pki/owner.key`          | `d43685a5e3a0c6fc520ec2a4f8c6e714bdb85a4fc600cf3f24fedfdcfc85038c` |
| `pki/server.crt`         | `91d812ca77ced38220d9adc9366bacefe75310e5681c8efd65b7c1f9dee21d78` |
| `pki/server.csr`         | `52a1b8f947968fd062305134e3de130a967091e202746da78e6f297be78fd218` |
| `pki/server.ext`         | `4836947f5aa394d56b21a362d500564a85f988432985651b1de858296e882e6f` |
| `pki/server.key`         | `7f48b90119937ecae72c92963b56e83dc10ff3eeb04caadd802888832feecd04` |
| `port`                   | `b5a2658a8fd3e619fdd6f9f86016b2cd7542889e786faa247fef53c3e3a38ae6` |
| `probe-regression.mjs`   | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `process-title-test.py`  | `a73a2b029c939068709215621273ee605b564cbec890c0ef8c6990e2fdef2797` |
| `process.py`             | `6fea9f8ea6c224185b0defe3c81422c19d4dc9241af17bfc8a0aee440413c53e` |
| `proof.json`             | `144d0c972b9330d53135bf1db18ed314ed03892fd60e82f53b8c5d4370c6cf96` |
| `readiness-gateway.mjs`  | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`           | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `rfb-contract-test.mjs`  | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`        | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                 | `9711070effb9fe56e9397a55f687d5ae2f24a6551acd288f0f0d9deba48f8ac9` |
| `supervise.py`           | `5ce28ce8217b40e9591c51e31f90647e106fee9efe4fcbedb51df0cbaff71f21` |
| `viewer-diagnostics.mjs` | `f4bf0c9d13ab43d2bdb94999a1560ea51329f2c85c0460cf54ea387332ff049b` |
| `watchdog-ready-test.py` | `7200ccc461a397882f556adc5f923605e560848f6907d7b54c37385a5def8868` |
| `watchdog_ready.py`      | `58c90f9e370ae26b467249e3fe8ef1da2cd706cacde65a5391df4e51d9899776` |
| `window-test.mjs`        | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `window.mjs`             | `42699e01f2a2764c4ebd035248470c4b4780598b181aa4b8011cd3c59840897c` |
