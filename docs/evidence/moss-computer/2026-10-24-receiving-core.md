# Computer terminating receiving core evidence

Part of #3618/#3619/#3616/#3577; PR #3632. Base 46a12cf1e8ea9dcc237d830b4db01315dec3fb5b.
Production source 3fa1ba6f2d2c2d71d305ac522767bf274ff46e0a; test-only amendment
5e6f044f64ecba6f244f9523b4c729d44a24d0a1. The
[machine receipt](2026-10-24-receiving-core.json) fingerprints restored source, tests, checks,
controls and every independent review round. The [plan](../../superpowers/plans/2026-10-24-moss-computer-receiving-core.md)
and [next dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-gateway-process.md)
preserve the continuing autonomous review/fix/verify/merge/verified-successor chain.

This is an **internal library**, not an installed gateway or owner feature. No ordinary API boot
listener, route, browser viewer, image, runtime admission or guest launch is added. App-map and
deployment configuration have no new product requirement. The host runner keeps unavailable
admission. Green library checks do not satisfy the product live-path gate.

## Implemented boundary

One supplied exclusively owned guest Duplex passes through a rejecting standard RFB3.8 envelope
before vendor decode. ServerInit dimensions/format/name, Raw-only rectangle geometry/count/aggregate
pixels, message types, chunk/partial-record sizes, handshake and partial deadlines are checked
before allocation-driving records reach rfb2. One complete validated record per event-loop turn
avoids queued vendor updates; no compressed/cursor/resize/clipboard decoder is admitted.

Every upstream public write reserves twice the complete adapter queue plus actual raw backlog.
This includes vendor-generated peer Fence replies, so a stalled raw callback cannot hide queued
adapter writes or a later larger raw copy. At most one outstanding requested frame has a two-second
response deadline. A complete first full-screen Raw rectangle precedes readiness. One public
Framebuffer stores current pixels; requests coalesce per receiving parser and full frames render
at most 5 Hz. Output supports actual noVNC rgbx and bgrx via vendor conversion, checking combined raw
and parser backlog before converting/sending. Slow viewers are destroyed.

Each viewer consumes actual Unix auth IPC and the accepted sole input receiver. Auth push/loss
synchronously invalidates receiving policy and closes affected streams. Deliberate local channel
closure suppresses only its own callback, preserving other same-session controllers and transferring
Moss-grant monitor ownership before old monitor cleanup. Monitors count within the four pending/
active lifetimes. A returning/controlling-close lifetime lost during Fence/auth explicitly fences
its fixed session before rejecting; disconnect alone preserves grants. Existing parser epochs,
pressed releases, matching Fence and fresh post-Fence authorization remain in force.

## Independent review ledger

All reviewers are independent and read-only; they authored no fixes. Exact receipts/hashes are in
JSON and private immutable artifacts.

- Plan R1 blocked downstream wrapper backlog, deliberate same-session auth closure and actual
  noVNC rgbx compatibility. All accepted; R2 accepted d071911c2 for internal no-launch implementation.
- Source 03a4f3575: Standards passed. Spec P1 found an orphan-grant race if the returning viewer
  disconnects during Fence/auth and a same-session watcher completes fresh auth. Spec P2 found
  missing controller frame assertion. Security B1 found automatic Fence replies bypassed the
  upstream \_write-only backlog check. All accepted and corrected in 97f6778ac with regressions.
- Source 97f6778ac: Spec passed; Standards passed with an optional-callback note. Security found
  the strict aggregate bound still missed a larger queued write's future raw copy after a smaller
  callback completed. Accepted; 3fa1ba6f2 reserves all queued copies and normalizes callbacks.
- Standards R3, Spec R3 and security source R3 passed 3fa1ba6f2, zero remaining source blockers.
  The later test-only amendment isolates the vendor flood from the frame-request precheck; no
  production source changed. Source acceptance does not substitute for final evidence or CI.

## Final restored checks

All commands unpiped, exit 0; exact arrays and raw-log SHA-256 are in JSON:

- Six-file scoped Vitest: **111 passed**. Envelope, gateway, existing receiver, policy, auth IPC
  and auth-lifetime suites.
- Root TypeScript and tests TypeScript.
- Scoped ESLint on all seven changed TypeScript files, max warnings 0; scoped Prettier including
  plan and handoff; file-size gate; git diff --check.

The initial scoped install omitted web/worker/spike dependencies needed by repository-wide types.
Existing installation/cache were inspected; a scoped frozen offline completion lacked one tarball,
so frozen installation completed from the registry without manifest/lockfile changes. An initial
new-test this annotation was corrected. Final root/tests checks pass after those corrections.

Tests use actual rfb2 wire parsers and real temporary Unix auth sockets. Synthetic session lookup
and the library server's missing Fence extension are disclosed stand-ins. A late-open scheduling
regression delays the real receiver connect result after actual auth/receiver execution. Exact
red/blue-distinct pixels reach watcher bgrx/rgbx and controller streams; wire input, pressed release,
takeover/return/intentional close, unexpected loss, same-session monitor ownership, delayed revoked
input, pending lifetime bounds, missing frames, unsupported formats and guest/auth loss are exercised.
This is no actual TigerVNC, real login or runtime-resource proof.

## Observed removed-protection controls

Each final control exited 1 at the intended behavioral assertion. Source restored after each;
original hashes match the final production source and the restored full suite passes. No compile
error or test-harness timeout is counted.

| Removed protection                      | Observed assertion                                                  |
| --------------------------------------- | ------------------------------------------------------------------- |
| Raw encoding whitelist                  | Forbidden encodings forwarded instead of envelope destruction       |
| In-frame geometry                       | Out-of-frame rectangle accepted                                     |
| Aggregate pixel budget                  | Overlapping rectangles beyond maximum pixels accepted               |
| Partial-record deadline                 | Trickled partial record remained alive                              |
| Synchronous auth retirement composition | Revoked viewer remained connected                                   |
| Post-await viewer lifetime              | Open resolved after gateway shutdown                                |
| Lost-return grant fencing               | Failed return and controlling close remained moss instead of paused |
| Upstream public write admission         | Automatic vendor Fence flood stayed open within assertion window    |
| Complete queued raw-copy reserve        | Actual raw+adapter bytes 65576 exceeded 65536 under old formula     |
| Deliberate-local retirement marker      | Closing watcher paused same-session controller                      |
| Downstream combined backlog preflight   | Stalled viewer stayed connected                                     |

The first upstream-write control exited 0 because the later frame-request precheck also closed the
connection. That rejected observation is retained in JSON/private logs and never counted as proof.
The corrected test waits until a response is outstanding and withheld before stalling replies;
removing write admission then fails the closed-core assertion before the two-second response
limit. Both actual vendor and direct raw+adapter queue assertions support this boundary.

## Remaining acceptance and resources

Independent exact evidence acceptance and required green CI precede merge. Keep #3618/#3619/#3616/
#3577 open. Next implement separately supervised process/private API transport, predecoder WebSocket
bounds and exact gateway image qualification, then independent fresh admission/watchdog and actual
fixed lifecycle operations/closure. Real TigerVNC Fence compatibility and ordering remain a gate.
Ordinary owner HTTPS/WSS, trusted bundled viewer, approved chat UI, actual login/frame/input/takeover/
return/close, hostile active sessions and stale/pressed input need independent live evidence.
Idle sleep/wake, confined useful Internet egress and release/platform claims remain separately bounded.

Only test in-memory streams and temporary auth Unix sockets were opened and closed. No DB,
Docker/image, guest, browser, TCP listener/devport or production runtime was started/mutated.
Historical private artifacts are read-only; no accepted r21 persistence rerun. R12 connection/r18
clipboard causes remain unknown. Private state/logs stay outside ~/Jarv1s. Continuing authority
requires verified isolated successor execution after merge; it grants no production deployment.
