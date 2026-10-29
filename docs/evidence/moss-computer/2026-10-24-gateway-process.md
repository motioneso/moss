# Computer separate process and private transport evidence

Part of #3618/#3619/#3616/#3577. Base `583819299a29c900a5391aef4fcdf5952b87f1d4` (merged
PR#3632); accepted source `17f45ed68b0bd9e735f1a0d8d17dbfdb0aedec63`. The
[machine receipt](2026-10-24-gateway-process.json) records source/test hashes, actual command exits,
negative controls and immutable independent review receipts. The
[plan](../../superpowers/plans/2026-10-24-moss-computer-gateway-process.md) and
[next dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-gateway-runtime.md) preserve the
continuing independent review/fix/verify/merge/verified-successor chain until actual owner delivery.

This is opt-in **internal tooling**, not an installed or qualified Computer. Normal API boot is
unchanged; there is no owner route/viewer, product app-map capability or deployment requirement.
Host unavailableAdmission remains unchanged. Image fit, runtime admission/watchdog, live TigerVNC,
actual lifecycle/closure and ordinary owner HTTPS/WSS/chat acceptance remain open. No internal
check substitutes for these gates.

## Implemented boundary

A separate Node executable consumes the existing receiving core/auth IPC/sole writer and one
trusted fixed Unix WebSocket guest target. It reserves its exclusive private IPC endpoint before
opening that target. Starting connections are rejected; failed startup closes the owned endpoint.
Canonical private parent, private0600 bind, exclusive hardlink alias publication and dev/ino-owned
cleanup reuse the auth endpoint mechanism. Replacement endpoints survive old-service closure.
Configuration is fixed local metadata, NOFOLLOW|NONBLOCK opened then fstat-validated regular0600
file in its canonical0700 parent, with a4096byte read limit and exact distinct normalized paths.

The ws8.21.1 adapter installs payload/fragment/buffered-chunk limits before vendor decoding,
disables compression/redirects/automatic pong, checks binary protocol and maintains an absolute
2s handshake/complete-message deadline. Fragments, byte trickles and pings cannot refresh it.
Public writes reserve queued adapter copies plus actual vendor backlog; manual pongs also preflight.
These component limits do not qualify the whole128MiB gateway image.

Private Unix IPC provides strict correlated bounded control requests and separate raw standard-RFB
streams. Four control lifetimes/four streams and12 total sockets include pending headers. IDs are
trusted API-issued auth bindings mapped to local core handles. Stable control loss disconnects
its viewer and streams; replaceable RFB EOF during return does not disconnect the stable control.
Core owns unexpected visual-loss policy, synchronous auth retirement, fresh Fence/auth barriers,
pressed releases and immutable parser epochs. The IPC client has deadlines, strict response shape/
correlation and no retry. Agent lease/dispatch IPC remains a tracked #3619 composition prerequisite.

## Independent review ledger

All reviewers were independent and read-only, authored no fixes and pinned Git source while
controls temporarily mutated the working source. Every round is retained privately and hashed in
JSON; no disputed blockers remain.

- Plan R1 blocked the missing reliable predecoder deadline and raw-stream-close cascading during
  return. Both accepted; R2 accepted the revised contract. R3 accepted reserve-IPC-before-guest
  startup ordering before that amendment was implemented.
- Source R1 on17dea5475: Standards and Spec passed. Security found FIFO configuration could block
  open before regular-file validation and prevent TERM completion. Accepted; NONBLOCK added before
  fstat, with an actual private FIFO subprocess regression observed red then green.
- Broader verification exposed actual stalled Unix WebSocket startup remaining alive after TERM.
  Configured vendor handshakeTimeout alone did not close this custom Unix path. An adapter-owned
  absolute2s deadline corrects it. The executable regression asserts a bounded exit and exact
  endpoint/private-directory cleanup; removing the deadline fails “still running” versus exit1.
  Earlier timeouts are retained as failed checks, never counted as negative-control acceptance.
- Source R2 on17f45ed68: Standards, Spec and security all passed, zero blocking findings.
  Standards' optional tiny exact-key predicate duplication note was retained without coupling
  gateway framing to auth implementation. The connection-cap assertion was strengthened so later
  header expiry cannot mask a missing immediate cap.

## Final restored verification

Final unpiped checks and exact raw-log hashes are recorded in JSON: root TypeScript, tests
TypeScript, scoped ESLint/Prettier, file-size, whitespace and the ten-file139-test behavior suite.
The suite includes existing receiver/policy/auth/core regressions plus actual Unix sockets, ws
framing and the opt-in executable. It checks pixel readback, watching without input, owner input,
pressed releases, takeover/return/intentional close, active revoke, raw/control loss, wrong binding/
correlation, header/connection limits, startup conflict/failure/TERM, permissions and replacement
endpoint preservation. All owned fixture sockets/children close.

Synthetic fresh session lookup and the rfb2 library server's missing Fence-extension fixture are
disclosed stand-ins. No actual TigerVNC Fence, owner login/UI, image resource fit or runtime proof
is claimed. The initial lint run preceded the final type-import correction; an earlier broad
startup timeout was diagnosed and corrected. Final evidence refers to restored committed source.

## Observed removed-protection controls

Each exited1 at the intended assertion; every source file restored to its original hash. No
compiler error or test-harness timeout is counted. JSON retains exact mutations and assertions.

| Removed protection         | Observed assertion                                   |
| -------------------------- | ---------------------------------------------------- |
| WS payload limit           | Oversized message left adapter open                  |
| WS fragment limit          | More than1024 fragments left adapter open            |
| Public WS queue preflight  | Corked adapter flood remained open                   |
| Complete-message deadline  | Ping-only idle remained open                         |
| Adapter startup deadline   | Actual TERM child still running after4s              |
| Nonblocking config open    | FIFO child status null instead of0                   |
| Private client correlation | Wrong-correlated reply resolved instead of rejecting |
| Private outgoing queue cap | Corked command flood was not refused                 |
| Control-loss disconnect    | Owner mode/viewer survived control-channel loss      |
| Immediate connection cap   | Thirteenth unbound socket remained open              |
| Endpoint inode ownership   | Old service removed replacement endpoint             |

## Remaining acceptance and resources

Required green CI and independent exact final evidence review precede merge. Keep #3618/#3619/
#3616/#3577 open. Next: exact image packaging/qualification, independently supervised fresh resource
admission/watchdog/invalidation/closure, actual fixed lifecycle and real TigerVNC ordering, then
ordinary owner HTTPS/WSS/trusted assets/approved chat and actual login/frame/input/takeover/return/
intentional-close with hostile/expired/revoked active sessions, stale/pressed input and fresh agent
leases. Idle sleep/wake, confined useful Internet egress and release/platform claims stay bounded.

Only temporary Unix test fixtures/in-memory streams and child executables were started. No actual
DB, Docker/image, desktop, browser, TCP listener/devport or production resource was mutated. Accepted
r21 persistence was reused without requalification; r12 connection/r18 clipboard causes remain
unknown. Private state/logs remain outside ~/Jarv1s. Continuing authority requires verified fresh
isolated successor execution after merge; it grants no production deployment.
