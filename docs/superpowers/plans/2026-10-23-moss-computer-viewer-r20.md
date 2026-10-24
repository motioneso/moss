# Computer viewer r20: instrumented diagnosis and persistence

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

## Exact identity and safeguards

Private sibling `../moss-computer-viewer-r20/`; fresh empty home/socket, unique proof token and fresh
one-day synthetic CA/server/owner/foreign identities. Port 5188 was claimed as `computer-viewer-r20`.
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
fresh r20 requirement; earlier failures are never converted into passes.

Guest UID1000/network none/Unix socket, 2CPU/4GiB/512PIDs; separate trusted gateway
0.5CPU/128MiB/32PIDs, loopback5188. Read-only roots, dropped capabilities, no-new-privileges/default
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

Manifest SHA-256 `e112528762096c4ce6700cdd90244c820183d0b0b512bd655a50e81b9688bc0b`; 55 immutable inputs, excluding receipts and manifest itself.

| Artifact                     | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `.env`                       | `2ac169e0a4a9125eb741720fa016e356941f430b4f6e8c2bdd63883a696a9f30` |
| `access-check.mjs`           | `39486c8498f88893b58be2a4cd089f4c939220c0ff48d6604377e19ea65288f3` |
| `access-controls.py`         | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `admission.py`               | `b597f991920207e8b551b6f93e41cce419ceb61ebf15c1ba54bc2c522baa33d3` |
| `browser-control-test.mjs`   | `3eab390b0b7d09b4a380021338cdfb51f5149d0131877d7ab6c9bedf5e33ceb7` |
| `check-state.py`             | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `client/ca.crt`              | `5dfe26995c3ca617d6dae839af137ec039193bb807a00fd47eef0e120af48843` |
| `client/foreign.crt`         | `9665789caa55b5f953825a422a80362d34dd920efc0363fe0ca0d98c1ea7ea36` |
| `client/foreign.key`         | `390f71908e11dbc3a1785f73935e31fe5017c258db6baed02eab36c5474007fd` |
| `client/owner.crt`           | `a8f38c7afdba37c344d4e189aeababe16ba3b534381f57dbfeb3215dbc5ee838` |
| `client/owner.key`           | `1318895ee130048b455e13f7e0034ccab84de23c87bcd822ef0d872dcfcc9689` |
| `compose.yaml`               | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `controls-lifecycle-test.py` | `fb5d00e261e7fcfc67b8526790c2a1d92eb29e0a228dad6c8a59550fd6f5f1b2` |
| `controls.py`                | `ad5e88095ccd2a2d669381a7f26707ae2d28d6a6f67f953d8f17c6de799cfc31` |
| `diagnostic-check.mjs`       | `03468ad6f5c52f4e7668c9d9d0ddfb6dee204fc894b0ac989ea542f8a6c5a456` |
| `diagnostics.py`             | `809400714554b8aaf2c48bfbc7c6eb353e1dbcc9607987f40e2f8889c9615bef` |
| `focus-test.mjs`             | `d91e5020221fcd2f1b8daace548497887fabd1161689363cae4ee4e901dcc403` |
| `gateway/ca.crt`             | `5dfe26995c3ca617d6dae839af137ec039193bb807a00fd47eef0e120af48843` |
| `gateway/nginx.conf`         | `799f4bc7878c1d325151195f3ff3746ae2b10526b0d07395c94c032456d3ac6a` |
| `gateway/server.crt`         | `0d94efcd68cb506a8fbc968bfd6ab626c870fe5b2c33f38f5cd56f58f9e0da6e` |
| `gateway/server.key`         | `812df9e10cfc19ce75041297947fb829558d9682cf53302cf0bf1f8ecbb1880f` |
| `guest-contract-test.py`     | `e64ee56724f5b0157ad6ee3a7e055779a0df138291af8c86e2021eef88cb7a53` |
| `guest-rfb.py`               | `9a4718e3b7cbea89e78b5d8aeca4d08cfdfbe802384c537f293d17b63952e310` |
| `isolation.py`               | `e479773cba0138fbcf49c2445d8b90708a1e33a1c275adfcc844e7c7cc3752a8` |
| `mutate.py`                  | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |
| `persistence.mjs`            | `b0054455faa7ccdb81fb22ce95806c98a871dc56c800c539627ffb5cd4db99e5` |
| `pki/ca.crt`                 | `5dfe26995c3ca617d6dae839af137ec039193bb807a00fd47eef0e120af48843` |
| `pki/ca.key`                 | `1996e4f240df07ef111bd0e88cfa49392643ebc95122a312144de8e5d2a849a3` |
| `pki/ca.srl`                 | `4f7a26316c3cae12c630f8ba4606d35cde4bb22106f7797ea4f51b9268dd4ab2` |
| `pki/foreign.crt`            | `9665789caa55b5f953825a422a80362d34dd920efc0363fe0ca0d98c1ea7ea36` |
| `pki/foreign.key`            | `390f71908e11dbc3a1785f73935e31fe5017c258db6baed02eab36c5474007fd` |
| `pki/owner.crt`              | `a8f38c7afdba37c344d4e189aeababe16ba3b534381f57dbfeb3215dbc5ee838` |
| `pki/owner.csr`              | `de8cab991ca3576cb1a2861f66b4a6483d69c5468bf6b43a1e4bc5acc48e32bc` |
| `pki/owner.ext`              | `0f47ccf77f8edd06ce567b7aab6ef3f88704863b73d22844b7a749c34f4a4506` |
| `pki/owner.key`              | `1318895ee130048b455e13f7e0034ccab84de23c87bcd822ef0d872dcfcc9689` |
| `pki/server.crt`             | `0d94efcd68cb506a8fbc968bfd6ab626c870fe5b2c33f38f5cd56f58f9e0da6e` |
| `pki/server.csr`             | `afef0bcc08efcbc72ea7415f605448597eb1a583b3621522d2d2812b0eea471c` |
| `pki/server.ext`             | `4836947f5aa394d56b21a362d500564a85f988432985651b1de858296e882e6f` |
| `pki/server.key`             | `812df9e10cfc19ce75041297947fb829558d9682cf53302cf0bf1f8ecbb1880f` |
| `port`                       | `3a743b77875a968e9ddb506de6b79034751583f983cb5de3f4146f7eba655440` |
| `probe-regression.mjs`       | `86c7097b619cf549171cf9558472981ca15abb5f3aca0035d3055d2b74324cb2` |
| `process-title-test.py`      | `a73a2b029c939068709215621273ee605b564cbec890c0ef8c6990e2fdef2797` |
| `process.py`                 | `6fea9f8ea6c224185b0defe3c81422c19d4dc9241af17bfc8a0aee440413c53e` |
| `proof.json`                 | `10e4f2b042a815f22c23e083f7a225aa3dd7c796f619a38fc2f7283ac219ed8f` |
| `readiness-gateway.mjs`      | `3dd6501aed8849f2beef1cdc0c06f49ad1894aad256d14e9e3a5a37e72310a9d` |
| `readiness.py`               | `ab08ae0040e937f798e4a40364a917b68c8d04694f51ae245f2b41cf5e0d5b13` |
| `rfb-contract-test.mjs`      | `a72688dfc2989c8caca5866a56594c2a8a31f1d9d211a975c7a96895bb107f8b` |
| `rfb-session.mjs`            | `688a32142b335dec7a4657f0b48673e4732b2a685e64c0d317d400a4c8be7792` |
| `run.py`                     | `e31aa968bf10c325298fc6bc2927b3e62b716dd4c7a77eb435722523cfe5a769` |
| `supervise.py`               | `c9c9938e82b6fac6761b17fcbf0afaa05b86329c6c1b67375929cb3784a06870` |
| `viewer-diagnostics.mjs`     | `f4bf0c9d13ab43d2bdb94999a1560ea51329f2c85c0460cf54ea387332ff049b` |
| `watchdog-ready-test.py`     | `7200ccc461a397882f556adc5f923605e560848f6907d7b54c37385a5def8868` |
| `watchdog_ready.py`          | `58c90f9e370ae26b467249e3fe8ef1da2cd706cacde65a5391df4e51d9899776` |
| `window-test.mjs`            | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `window.mjs`                 | `b6fcfa9b0819d369c59481ee04cad763e417ca77a3881b47876f8d4c54375a14` |
