# Computer viewer r21: instrumented diagnosis and persistence

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

R17 subsequently passed real viewer/input, active sandbox with actual added content filters and
clean Firefox shutdown. The copied-bookmark negative control then failed on its open connection's
WAL before reaching the intended missing-bookmark assertion. R18 closes that copied connection
after committing its transaction and before invoking the checker. No WAL guard, mutation assertion,
negative control or real-profile check is removed. Actual old/new scripts replayed on separate
copies of r17's clean file/database: original wrong-WAL failure observed, corrected pristine
controls pass and exact file-tamper/bookmark-removal assertions reject; one actual bookmark row
removed and real durable hashes unchanged. R17 did not reach replacement and remains incomplete.

R18 again connected the real viewer/frame/input but its initial Firefox address clipboard poll
then timed out. Cause remains unproven: retained EWMH active-window status is not keyboard focus.
R19 waits for actual keyboard focus matching the freshly verified Firefox window after activation,
before sending shortcuts; installed xdotool documents these distinct properties. The focus wait
is bounded at 5s; the original address poll remains 15s and each shortcut is still sent once.
Capture bounded distinct clipboard values and lengths, normalized and exact child-focus identities,
active-window identity, and a cropped viewer toolbar on failure. Unit controls verify delayed-focus
ordering, wrong-focus rejection and actual caller wiring; they do not explain r18 or qualify the
desktop. All real viewer/sandbox/flush/negative-control/replacement assertions remain mandatory.

R19 completed same-home/image replacement with unchanged durable file/profile hashes, then passed
fresh connected frame and input. Its initial about:blank address read failed with correct actual
focus and unchanged clipboard sentinel; the cropped toolbar shows Firefox's intentionally empty
address field. R20 replaces that unobservable literal with a unique unbookmarked local fixture URL
whose control fragment differs from the persisted bookmark target. Assert those URLs differ, then
require exact initial-control URL readback via real viewer keyboard/clipboard before the unchanged
bookmark-only search and exact persisted-target URL readback. The initial-state negative control
is preserved. Actual caller replay rejects already-on-target, unchanged sentinel and aliased
control URL, and accepts only the exact distinct control; it is not live desktop acceptance.
All original durability, sandbox, flush, data mutation, frame/input and closure requirements remain.

R20 passed exact distinct-control URL readback after replacement, then retained the unique token
in bookmark-search mode rather than opening the actual persisted suggestion. The cropped toolbar
shows the single bookmark's correct title/target. R21 explicitly selects that suggestion with one
Arrow Down followed by one Enter through viewer keyboard. The unique bookmark-only query and
original 1000ms suggestion wait remain; exact reopened-target URL readback still gates acceptance.
Actual caller replay verifies key ordering/count and retained target assertion; fresh actual proof
metadata is checked for its distinct local initial-control URL. Live completion remains required.

## Exact identity and safeguards

Private sibling `../moss-computer-viewer-r21/`; fresh empty home/socket, unique proof token and fresh
one-day synthetic CA/server/owner/foreign identities. Port 5180 was claimed as `computer-viewer-r21`.
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
fresh r21 requirement; earlier failures are never converted into passes.

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

Manifest SHA-256 `9aec7a404c9951a6afbc3f296059fe98cf9cc749905139827195eb2c738db6ea`; 56 immutable inputs, excluding receipts and manifest itself.

| Artifact                      | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `.env`                        | `253eba077ac1f6541d0ef67aca44ff652c1260e21b88b9d0bb641a94cd38a8ab` |
| `access-check.mjs`            | `e4c590cf081e8be07c9310a5ea1cf0eb4b6853e56037fc68654fb661acf2f602` |
| `access-controls.py`          | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`                | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `bookmark-selection-test.mjs` | `bcaa12efae6efdaf89fce1d68482921b5a6adac401b7b5a4665126f6456f030b` |
| `browser-control-test.mjs`    | `3eab390b0b7d09b4a380021338cdfb51f5149d0131877d7ab6c9bedf5e33ceb7` |
| `check-state.py`              | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `client/ca.crt`               | `3e71fac1be0bfeb0558a261f6a11a8ad2c71c346d6f4066d26ac672bb4532c2c` |
| `client/foreign.crt`          | `38543789893d3a457efd4bf0735d36af25c5b56cf54b2d254fd0c79ac1ee77c1` |
| `client/foreign.key`          | `4281f185fbf9ada5248649c5d192ef98aeb119696a819e263c401b8e37ea5d27` |
| `client/owner.crt`            | `01af5a1b33b14df0455d38d5acc05c4bc2936e5f1a238ce29182b02ba0aca473` |
| `client/owner.key`            | `d987dbc8153089d9f7e729d98426ad0c8f8ba6182143bff848f5c6d45c785171` |
| `compose.yaml`                | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `controls-lifecycle-test.py`  | `fb5d00e261e7fcfc67b8526790c2a1d92eb29e0a228dad6c8a59550fd6f5f1b2` |
| `controls.py`                 | `ad5e88095ccd2a2d669381a7f26707ae2d28d6a6f67f953d8f17c6de799cfc31` |
| `diagnostic-check.mjs`        | `19bb376aa0db95a70658851ff1722b270bc7b713ded9f112f249438e1ef02223` |
| `diagnostics.py`              | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `focus-test.mjs`              | `d91e5020221fcd2f1b8daace548497887fabd1161689363cae4ee4e901dcc403` |
| `gateway/ca.crt`              | `3e71fac1be0bfeb0558a261f6a11a8ad2c71c346d6f4066d26ac672bb4532c2c` |
| `gateway/nginx.conf`          | `931f92b1b0f7265b430bdbf1c130663de751dfec7192588cf0ab97e203d2f431` |
| `gateway/server.crt`          | `b6a0e1d7df9f4ba608fa4ddf319961e4fda56f1883dfb0822f14dba0dcd1b5f3` |
| `gateway/server.key`          | `f03428b23f857466785300b3b2fda03ab6551aaedb914ecbf080243d04d0ff9d` |
| `guest-contract-test.py`      | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`                | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`                | `e573e26405aad68915cd7ce17813dc6933bb6e74c4ad554ae75032f6c73b618f` |
| `mutate.py`                   | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `persistence.mjs`             | `be3722e2757bf1df208e2da1d449a6176007195f5c099e7b1d28f28c9bdd5d4d` |
| `pki/ca.crt`                  | `3e71fac1be0bfeb0558a261f6a11a8ad2c71c346d6f4066d26ac672bb4532c2c` |
| `pki/ca.key`                  | `c587f716163a42a4e7f2f43915326cc2864356b7fdae3de6c093f454c7199e10` |
| `pki/ca.srl`                  | `961a5b5258348e2956674dfe41809417d084f829b5ce1532fd022439e37d3196` |
| `pki/foreign.crt`             | `38543789893d3a457efd4bf0735d36af25c5b56cf54b2d254fd0c79ac1ee77c1` |
| `pki/foreign.key`             | `4281f185fbf9ada5248649c5d192ef98aeb119696a819e263c401b8e37ea5d27` |
| `pki/owner.crt`               | `01af5a1b33b14df0455d38d5acc05c4bc2936e5f1a238ce29182b02ba0aca473` |
| `pki/owner.csr`               | `7cb2bacdf1a82a3573780d1907036e351560d80f2cc514c61b36ccf07900a70f` |
| `pki/owner.ext`               | `0f47ccf77f8edd06ce567b7aab6ef3f88704863b73d22844b7a749c34f4a4506` |
| `pki/owner.key`               | `d987dbc8153089d9f7e729d98426ad0c8f8ba6182143bff848f5c6d45c785171` |
| `pki/server.crt`              | `b6a0e1d7df9f4ba608fa4ddf319961e4fda56f1883dfb0822f14dba0dcd1b5f3` |
| `pki/server.csr`              | `1acf3b31f233e6b63289b1aecd9a4536bd748b092918ce822ab864a7884c189b` |
| `pki/server.ext`              | `4836947f5aa394d56b21a362d500564a85f988432985651b1de858296e882e6f` |
| `pki/server.key`              | `f03428b23f857466785300b3b2fda03ab6551aaedb914ecbf080243d04d0ff9d` |
| `port`                        | `b5a2658a8fd3e619fdd6f9f86016b2cd7542889e786faa247fef53c3e3a38ae6` |
| `probe-regression.mjs`        | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `process-title-test.py`       | `a73a2b029c939068709215621273ee605b564cbec890c0ef8c6990e2fdef2797` |
| `process.py`                  | `6fea9f8ea6c224185b0defe3c81422c19d4dc9241af17bfc8a0aee440413c53e` |
| `proof.json`                  | `765aa1eb5701e7f5e2c4b0ab007e120a00dc4730503823bc6c258d3e84917199` |
| `readiness-gateway.mjs`       | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`                | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `rfb-contract-test.mjs`       | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`             | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                      | `97c0e4cb485a3c3e0b25e62a73b2ee6b160dbf87c198e5c5e60e6ee62ba3d789` |
| `supervise.py`                | `7541d456a75932850ef1fb70aed7061de7152b7768f343a97115ce3f8e41a621` |
| `viewer-diagnostics.mjs`      | `f4bf0c9d13ab43d2bdb94999a1560ea51329f2c85c0460cf54ea387332ff049b` |
| `watchdog-ready-test.py`      | `7200ccc461a397882f556adc5f923605e560848f6907d7b54c37385a5def8868` |
| `watchdog_ready.py`           | `58c90f9e370ae26b467249e3fe8ef1da2cd706cacde65a5391df4e51d9899776` |
| `window-test.mjs`             | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `window.mjs`                  | `b6fcfa9b0819d369c59481ee04cad763e417ca77a3881b47876f8d4c54375a14` |
