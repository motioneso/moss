# Computer viewer r16: instrumented diagnosis and persistence

Task #3578 / parent #3577; owner integration #3605. Operator Codex `/root`; independent read-only
reviewer `/root/viewer_review`. Ben directly instructed continued repair, superseding the prior
unsupported-repair stopping decision in the [diagnostic plan](2026-10-23-moss-computer-viewer-diagnosis.md).
No causal viewer repair is claimed before this run. The observed watchdog first-sample race is repaired. This attempt records the missing browser boundary
while preserving the entire r12 acceptance sequence and original deadlines.

## Exact identity and safeguards

Private sibling `../moss-computer-viewer-r16/`; fresh empty home/socket, unique proof token and fresh
one-day synthetic CA/server/owner/foreign identities. Port 5180 was claimed as `computer-viewer-r16`.
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
fresh r16 requirement; earlier failures are never converted into passes.

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

Manifest SHA-256 `3cea2b592f9caafc7e3b0412774e8056d3890fecb62841a0b86990ada1e6104b`; 51 immutable inputs, excluding receipts and the manifest itself.

| Artifact                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `.env`                   | `d1482e929e6dc91d3fa7462c71b3683d8dbdc375d3c4d3cbd2234606934191af` |
| `access-check.mjs`       | `652bb0269cf063d79f65d5e7bc2eeb6ee56fa23e92841452ad7437d167539567` |
| `access-controls.py`     | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`           | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `check-state.py`         | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `client/ca.crt`          | `cf13de2baf62dd55218cd330bb5237d853293893b5689720bdfe3d9c5a8878a0` |
| `client/foreign.crt`     | `68b6d40e38bc3eba0f88d0b42bf86cab976b2837ddf5c6223922015855adb586` |
| `client/foreign.key`     | `12300074a4615f3449ebcebdcb0b73022209cdd93b94b8d49cfca84bd3639729` |
| `client/owner.crt`       | `d45ae2ab788759595b4239f941fa0bb7116ceb649cf782e331e8353715bda187` |
| `client/owner.key`       | `4ebdfd0b7ea0a996d3bc156f1623c44336cc6dea5aeb8c8db88f1367d397c9a0` |
| `compose.yaml`           | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `controls.py`            | `c9e56dc2a2502a3fd5bab625e9549a42c767f3a16a91a75a8c484059c44ade18` |
| `diagnostic-check.mjs`   | `19bb376aa0db95a70658851ff1722b270bc7b713ded9f112f249438e1ef02223` |
| `diagnostics.py`         | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `gateway/ca.crt`         | `cf13de2baf62dd55218cd330bb5237d853293893b5689720bdfe3d9c5a8878a0` |
| `gateway/nginx.conf`     | `931f92b1b0f7265b430bdbf1c130663de751dfec7192588cf0ab97e203d2f431` |
| `gateway/server.crt`     | `6e51f6af4502f0c0409c381a8d1347fd1ecb062df8f6c758d7bc7a0f90c3dc3e` |
| `gateway/server.key`     | `805882289db86bc24622119a71daf37e0dadd41351751816551ef18aa1dc88aa` |
| `guest-contract-test.py` | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`           | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`           | `c3d0ea0b4d67ac2d2a60e34700507f25bc34d804c3426454f855c0ec24552cc1` |
| `mutate.py`              | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `persistence.mjs`        | `e56ffb84b3a4f31453ac9fc628caed8d47fcd1a7802858b28bac2fd5416bdada` |
| `pki/ca.crt`             | `cf13de2baf62dd55218cd330bb5237d853293893b5689720bdfe3d9c5a8878a0` |
| `pki/ca.key`             | `f72b0c4746ee5cdc8e8b8d8c4868d35ad9337b34adae0cb3b20ba1a711abd105` |
| `pki/ca.srl`             | `af6ddaf21168131469c957d6baa99f23db47683f59e7d466096bcc1e9848e59c` |
| `pki/foreign.crt`        | `68b6d40e38bc3eba0f88d0b42bf86cab976b2837ddf5c6223922015855adb586` |
| `pki/foreign.key`        | `12300074a4615f3449ebcebdcb0b73022209cdd93b94b8d49cfca84bd3639729` |
| `pki/owner.crt`          | `d45ae2ab788759595b4239f941fa0bb7116ceb649cf782e331e8353715bda187` |
| `pki/owner.csr`          | `c094e2490819bad7c70f9ba827c6ec2fc277be63b2a5d8b8b4d494535c1749c0` |
| `pki/owner.ext`          | `0f47ccf77f8edd06ce567b7aab6ef3f88704863b73d22844b7a749c34f4a4506` |
| `pki/owner.key`          | `4ebdfd0b7ea0a996d3bc156f1623c44336cc6dea5aeb8c8db88f1367d397c9a0` |
| `pki/server.crt`         | `6e51f6af4502f0c0409c381a8d1347fd1ecb062df8f6c758d7bc7a0f90c3dc3e` |
| `pki/server.csr`         | `f5fdc7510abe87e606533ba449a594028b59c146d6a7fdf33a00b6f2a7bdde96` |
| `pki/server.ext`         | `4836947f5aa394d56b21a362d500564a85f988432985651b1de858296e882e6f` |
| `pki/server.key`         | `805882289db86bc24622119a71daf37e0dadd41351751816551ef18aa1dc88aa` |
| `port`                   | `b5a2658a8fd3e619fdd6f9f86016b2cd7542889e786faa247fef53c3e3a38ae6` |
| `probe-regression.mjs`   | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `process.py`             | `2ede92bae11e2fca8ccf611534d27bbfaf08311e63ed13e06732a38d92f9f5c7` |
| `proof.json`             | `ae817d617340493a3c84db5339cdd1a005b925233ed2730c0215e58c947f07fc` |
| `readiness-gateway.mjs`  | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`           | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `rfb-contract-test.mjs`  | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`        | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                 | `5a955f24ed6994cff160ca56b41fd1c49a15b54d439f03ff41f72c700ba31bce` |
| `supervise.py`           | `6adee14c1d4ca714836b9e03b09fd2897b2745adf935a6a9c8f52764490c6395` |
| `viewer-diagnostics.mjs` | `f4bf0c9d13ab43d2bdb94999a1560ea51329f2c85c0460cf54ea387332ff049b` |
| `watchdog-ready-test.py` | `7200ccc461a397882f556adc5f923605e560848f6907d7b54c37385a5def8868` |
| `watchdog_ready.py`      | `58c90f9e370ae26b467249e3fe8ef1da2cd706cacde65a5391df4e51d9899776` |
| `window-test.mjs`        | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `window.mjs`             | `42699e01f2a2764c4ebd035248470c4b4780598b181aa4b8011cd3c59840897c` |
