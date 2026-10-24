# Independently executed Computer closure tooling

Part of #3618/#3617/#3616/#3577. PR #3651 adds a distinct opt-in verifier; this is tooling
evidence, not installed trust, an actual Computer run, runtime admission or owner completion.
The full [machine-readable evidence](2026-10-24-independent-closure.json) carries exact source,
commands, exits, hashes, controls and review reports. Historical private evidence stayed read-only.

## Exact source and prerequisite

- Base and verified PR #3650 merge: `eed6cc9db0575fb476e0f914d1c7d91657f5526f`.
  Its tree equals accepted final HEAD `353698e11ad8b1804dc0554ed15569ce524d9097` and all12
  published source hashes match. Fresh GitHub receipts reconcile local acceptance6384838999,
  supplemental acceptance6385026168, successful CI40098454116 attempt1 and required
  CI gate120888910736 at that exact final HEAD. All five parent owner issues remain open.
- Accepted contract: `21492cc8807c33db1d231cba0a07e049a6a9b59d`, independently accepted by
  security and Spec before implementation.
- Initial source: `6a70f1594db810a176cb5313c52d4c7091870373`. Independent security review
  requested a mount-boundary correction; independent Spec initially missed that gap.
- Corrected production and final checked source: `6ffe25c062c1e4ce96d3827d3ac207748b895815`.
  Both independent source reviewers accepted this exact corrected source; Standards found no
  structural blocker. The JSON pins all12 source/test file SHA256 values. Later evidence/handoff
  commits must preserve those bytes; exact final local acceptance and CI are separate gates.

## Implemented boundary

`scripts/computer-closure.ts <trusted-closure-config>` fixes monotonic startup time and one native
absolute60s timer before startup I/O. Repeated signals latch failure without extending it. Its
post-stop root loader retains trusted Node/code/config/key/namespace/socket/root validation without
requiring a live runner or heartbeat. It requires a distinct Ed25519 signer whose public key must
also be pinned by the future independently accepted run packet.

The verifier reads actual retained identity/state/immutable stop/journal snapshots without opening
HostStateStore or touching its lifecycle lock. It requires disabled state, exact original stop
binding, full resource IDs and creation generations; later request CAS can advance. The journal
supplies every recorded collector identity, never closure authority. Unknown raw collector PID
refuses complete proof. Only initial known-ID inspect404 can establish container absence.

It independently performs exact Docker inventory, actual PID-path and process-group absence,
bounded descriptor-pinned endpoint enumeration/native Unix connect and canonical Moss readiness,
then repeats those observations and checks file/config/root equality. Hidden bind sockets are
included. PID reuse, surviving groups, ambiguous transport, listeners and unsafe traversal refuse
closure. Only ENOENT/ECONNREFUSED qualifies a socket refusal; no application bytes are sent.
Inert guest socket inodes are retained. These are sampled observations, not continuous absence.

Security R1 correctly found that st_dev equality missed same-filesystem bind mounts. R2 reads
bounded Linux descriptor fdinfo mount IDs for roots, O_PATH|NOFOLLOW entries and child directories,
correlates inode/device/mode before/after probes and includes the root mount ID in repeated endpoint
hashes. The regression substitutes a different mount ID with the same actual device; no mount was
performed. Spec R2 explicitly corrected its initial assessment. Both reports/rounds are retained.

An exclusive bounded closure.jsonl contains signed attempt and observed-closed/failed records.
Not-yet-observed fields are explicitly null. File+directory fsync, close, final equality including
published receipt metadata and deadline precede native exit0. Signed observed-closed alone cannot
prove completion: held final persistence leaves that signed line but exits2. Failed/partial files
are retained, with no overwrite/reopen/reset. No key/config bodies or raw errors are emitted.

## Restored-source verification

All11 final commands exited0, unpiped, at the exact corrected source. Root and tests TypeScript,
scoped ESLint zero warnings, changed-file Prettier, file-size, whitespace, gateway context build
and builtin-only CJS closure/host/watchdog bundles passed. The full affected Computer run passed
**546 tests across27 suites**, including45 focused closure/trust tests. Node execution was
v22.22.2; Node24 bundle targeting is metadata and does not qualify actual Node24 execution.

Closure CJS is53924 bytes, host34326 and watchdog93560. Metafiles contain only node: builtin
external imports. Actual nonroot invocation of the production closure CJS was silent exit2 in
38.415ms, with UID/argv/artifact/stream/time receipts retained privately. It does not establish
installed root trust. Exact artifact, command and log hashes are in the JSON.

Seven separate native fixture invocations retained actual argv/UID/child PID/exit/complete streams,
monotonic times, artifact hashes, signed receipt bytes and public keys. Independent builtin crypto
revalidation verified every signature/public-key hash and receipt hash; three successful native
fixtures also match the signed verifier PID and native exit0. Four failures remain failures even
where an earlier valid receipt exists. Positive, stale socket, hidden listener, unhealthy Moss,
unknown collector and exclusive overwrite behavior are exercised. The native composition discloses
synthetic root/runtime/namespace/code/artifact/pre-stop tuple provenance and Unix Docker/readiness.
It cannot qualify the installed loader or a real Moss/Computer. Actual files, signatures/fsync,
detached process identities/groups, Unix listeners and stale socket probes are real.

All20 removed-protection controls failed at their intended executable assertions, each with its
patch/log hash and exact byte-for-byte restoration. They cover process/group absence, hidden
listeners, inventory, disabled state/original CAS, unknown collector, record/config equality,
deadline equality/signals, file/directory fsync, exclusive receipt, post-close publication equality,
readiness, signer/net anchors, private file metadata and same-device mount identity. Final green
checks followed restoration at the same exact source. Scaled native held-fsync tests use500ms for
the60s timer and repeated signals; they claim timer composition, not hard real time. Failed R1
fixture tests and source review are retained: the initial fixture kept its own host listener alive,
and the real verifier correctly refused closure until that fixture was closed.

## Gates and continuation

No Computer image/runtime/Docker/DB/browser/TCP-server operation, installation or deployment
occurred. No product/app-map/deployment default or unavailableAdmission change occurred. No
actual Node24/image/128MiB/TigerVNC, trusted installation/provenance, real Moss health, owner
cookie/Origin/HTTPS/WSS/chat or fresh agent-lease qualification is claimed.

Independent exact final local-evidence acceptance and exact final PR HEAD required green CI plus
supplemental acceptance precede protected actual merge; live PR records remain authoritative.
Verify actual merge/tree/hashes, then follow the complete
[trusted provisioning dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-trusted-provisioning.md)
with a verified fresh isolated successor. Actual post-create/pre-start config delivery, pre-stop
host process capture and key/namespace provenance remain implementation work. New-run/reset and
uncertain-create quiescence need separate accepted contracts. Before ANY runtime/image operation,
preserve every exact-packet/resource/watchdog/closure gate in that dispatch, reuse accepted r21
without standalone requalification and keep r12/r18 causes unknown. All parent owner issues stay
open. A merged prerequisite never finishes actual owner delivery.
