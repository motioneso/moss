# Independently executed Computer terminal closure

Part of #3618/#3617/#3616/#3577. Base `eed6cc9db0575fb476e0f914d1c7d91657f5526f`,
verified PR #3650 merge. Its tree equals accepted final HEAD
`353698e11ad8b1804dc0554ed15569ce524d9097`; all12 published hashes match. Fresh GitHub
receipts confirm final local acceptance6384838999, supplemental acceptance6385026168,
CI40098454116 attempt1 and required successful CI gate120888910736 at that exact HEAD.
All five parent issues remain open. Follow the complete
[closure dispatch](../handoffs/2026-10-24-moss-computer-closure-integration.md) and its
inherited contracts through review, checks, protected merge and verified fresh successors.

## Scope and seams inspected before planning

Build a distinct opt-in native executable that independently observes terminal closure and signs
its own retained receipt. It never calls the cleanup driver or accepts its outcome as proof.
No runtime/image operation, installation, launch admission, product wiring or deployment here.

- `scripts/computer-host/docker.ts:147`: complete exact-label inventory plus initial known-ID
  inspect404. Reuse its read-only path; pending-name404 and list misses never prove absence.
- `scripts/computer-host/recovery.ts:49`: immutable stop validation; :181 performs local cleanup,
  explicitly excluding independent closure. Read existing files without opening HostStateStore.
- `scripts/computer-watchdog/trust.ts:24`: configured runner, run, roots, artifact, boot and
  pid/mnt/user namespace anchors. Its :254 loader requires a live runner at :313–316 and cannot
  load a stopped run. Reuse its pure parser and bounded/trusted-file/namespace functions only.
- `scripts/computer-watchdog/journal.ts:17`: start watchdog and all collector identities,
  including terminal raw collectorPid when the full identity is unknown. Never invent it.
- `scripts/computer-watchdog/observe.ts:27`: exact bounded native Moss readiness check.
- `apps/api/src/computer/private-endpoint.ts:45`: private random bind paths and hardlink aliases.
  Alias absence does not establish endpoint closure. Guest viewer.sock may remain an inert inode.
- `scripts/computer-host/operations.ts:100–105`: library create→identity save→start has no trusted
  config provisioning hook; installed host executables cannot launch. Missing post-create/pre-start
  delivery remains implementation work owned by the next provisioning slice, not a successful stub.
- `scripts/computer-host/docker.ts:34`: no guest host PID/start/group capture exists. This verifier
  requires independently provisioned exact pre-stop desktop/gateway tuples in trusted config;
  missing capture/provenance refuses installed qualification. A separately accepted trusted capture
  service/run packet remains required before actual use. Tests disclose their synthetic binding.

Choose a separate executable over a callback inside managed cleanup: an independent process must
perform its own actual observations. A callback would inherit the cleanup process and could merely
restate its result. Codegraph tools are unavailable in this session; bounded source supplied citations.
Kill owner: computer-closure-integration. Reject any change needing API privileges, mutation,
lock takeover, identity fabrication, successful admission or cleanup self-certification.

## Trusted input and execution

New files under `scripts/computer-closure/`: `config.ts`, `records.ts`, `observe.ts`, `receipt.ts`,
`run.ts`; composition root `scripts/computer-closure.ts`. Focused native tests/fixtures under
`tests/unit/computer-closure-*`. Reuse existing helpers; keep unrelated runtime source unchanged.

`computer-closure <trusted-closure-config>` anchors hrtime before any I/O. One absolute60s deadline
covers bootstrap, observations, signing and file/directory fsync; equality refuses success. A native
process timer exits2 with partial receipts retained if I/O hangs. Repeated TERM/INT cannot yield
success or bypass pending persistence; terminal failure remains latched. No retries or reopen.

Exact configuration fields: `supervisor`, `artifactSha256`, `processes`, `netNamespace`, `receipt`,
`signingKeyPath`, `publicKeySha256`. `supervisor` uses the existing SupervisorConfiguration parser
and requires lifetime binding. It retains the original supervisor artifact hash and namespace
anchors; the outer artifactSha256 pins this verifier. `processes` has exactly watchdog, desktop,
gateway full PID/startTicks/processGroupId tuples; runner comes from supervisor. No duplicate PIDs;
runner/watchdog groups remain distinct. Guest tuples are trusted pre-stop host identities, never
container-namespace PIDs. netNamespace is an independently provisioned host net namespace link.
Compare self and PID1 to it as well as inherited boot/pid/mnt/user/full-range uid_map anchors.

Use the existing Linux/root/environment guard, absolute native Node executable and builtin-only
CJS artifact. Require root-owned non-writable code/Node/config ancestry, private0600 single-link
config in0700 parent, <=16KiB config and <=2MiB artifact. Revalidate metadata, bytes/hashes,
namespace anchors, Docker socket and exact recorded roots before and after observation.
Do not call the live-run supervisor loader or require heartbeat after shutdown.

Receipt is a pinned root-owned0700 RootIdentity outside all host/monitor/data/docker roots
(no ancestor/descendant overlap). The Ed25519 private PKCS8 PEM key has root-owned trusted ancestry,
0600 single-link regular metadata, <=4096bytes, and is outside guest/API mounts. Derive its public
SPKI bytes and require the configured SHA256. The separate accepted run packet must independently
pin this signer; neither a self-supplied receipt key nor the shared receiver HMAC is authority.
No secret/key/config bodies enter output or receipts. Actual installation and key/provenance trust
are separate packet gates; no files are chowned/installed by this slice.

## Actual closure observations

Read identity.json/state.json/stop.json with NOFOLLOW|NONBLOCK private regular-file validation;
retain bytes and dev/inode. Require exact configured roots and marker, disabled terminal state,
both retained full resource IDs and creation generations matching lifetime binding. Request CAS
may advance from binding; stop intent must bind its original request/resource identity. Reject
pending or missing tuples, malformed/replaced/symlinked files, changed bytes/inodes/roots and state
resurrection. Never acquire, release, delete or steal daemon.lock, stop intents, home or volumes.
Lock existence is reported only, not treated as closure or automatically repaired.

Read the actual bounded root monitor observation.jsonl, <=512KiB and<=802 records, each<=4096bytes.
Require complete newline-delimited start→collector/sample→single final stop ordering, exact run,
runner/watchdog tuples and no trailing record. Parse every collector tuple, including stop collector;
unknown collectorPid/full-identity mismatch refuses complete proof. Journal bytes/inode must remain
stable through final revalidation. The journal supplies identities, never resource-closure truth.

Independently call real ComputerDocker.inventory on the retained exact tuples and require empty.
Any remaining/mismatched/untracked resource or transport ambiguity fails. No image pull, create,
start, stop, remove, generic exec, mutation or retry exists in this verifier.

For every configured runner/watchdog/desktop/gateway and every journal collector tuple, require
actual `/proc/<pid>` ENOENT and process-group signal0 ESRCH. Any live, zombie, reused PID/group,
EPERM, malformed or inaccessible observation refuses closure. This conservative proof records
the expected start/group tuple but never treats a reused PID as the expected process's absence.
The verifier's own actual identity must differ from every recorded process/group.

Inspect controlDir, gatewayDir and guestSocketDir through pinned descriptors, bounded traversal
depth<=3 and<=256 entries total, no symlinks/devices/mount crossing/lossy names. Probe every socket,
including private bind paths, with native Unix connect and no application bytes. Only ENOENT or
ECONNREFUSED counts as refusal; successful connect, EACCES, timeout or replacement fails. Also probe
fixed host.sock, gateway.sock, lifetime.sock and viewer.sock even when absent. Record a hash of
the endpoint observations; do not delete stale sockets. Recheck enumeration/root identity after
awaits. Process/container absence supplies the guest namespace boundary; net anchor covers host
probes. These observations are bounded samples, not continuous absence or hard real time.

Check actual exact Moss readiness using the canonical2s helper. Repeat inventory, process/group
and endpoint checks plus healthy Moss before final file/config/root/journal equality and receipt
publication; no successful root/cleanup result can replace any check. One absolute deadline never
refreshes. A later new resource would invalidate that sampled receipt; no reset/new-run is allowed.

## Signed receipt and failure semantics

Open exclusive `closure.jsonl` under descriptor-pinned receipt root; refuse prior files. Write a
signed initial `attempt` record and fsync file+directory before observing. Append exactly one signed
`observed-closed` or `failed` record within total<=64KiB. Every signature covers domain/version,
record type, run/binding, native verifier identity, expected process tuples, initial/finished monotonic
times, config/artifact/state/stop/journal/endpoint hashes, public key hash and fixed outcome/reason.
No key, lifetime secret, private contents or raw errors. Do not assert durable success inside the
signed body: native exit0 only follows final file+directory fsync, descriptor close, deadline and
revalidation. A signed observed-closed line without the successful native completion receipt cannot
qualify closure. Failed/partial records remain; no truncation/deletion/reopen. Signing/fsync failure
returns nonzero, hangs exit2 at the absolute bound. Retain evidence and keys separately for review.

## Verification and continuation

Cache inspected; frozen offline scope includes root/API/worker/web/visual-chat spike and workspace
dependencies. No DB/foundation, Computer image/runtime/Docker operation, TCP server, browser or
installation. Native tests execute a distinct child composition against disclosed Unix Docker and
readiness fixtures, actual detached child PIDs/groups and Unix listeners. Root/config/namespace
trust and pre-stop guest tuples are disclosed fixtures; they do not establish installed provenance.

Test positive closure, signature/tamper, pending/remaining/untracked resources, reused/live PID/group,
unknown collector, hidden underlying listener, stale socket refusal, unhealthy Moss, changed
config/stop/state/journal/root, deadline equality, oversized/unsafe files, receipt overwrite and
failed/held file/directory fsync. Observe intended assertion failures with each claimed protection
removed; retain patches/logs and byte-for-byte restoration. Final green batch uses exact restored
source. Expected0 unpiped: focused closure plus affected Computer suites, root/tests TypeScript,
scoped ESLint zero warnings/Prettier, file-size, whitespace, builtin-only CJS closure/host/watchdog
bundles and gateway build. Actual nonroot CJS refusal must be silent exit2.

Commit this contract and obtain independent read-only security/Spec acceptance before code.
Then independent Standards+Spec/security source review/corrections, exact final local evidence
acceptance, exact final HEAD required green CI and supplemental acceptance precede protected actual
merge. Verify merge and fresh isolated successor with durable name, actual native UUID and
handoff-read execution acknowledgement. Keep all parents open. No product/app-map/deployment default
changes here. No UI/model calls; later product feedback comes from records and model proposes only
authorized tasks/input.

Preserve every gate in the closure dispatch: unavailableAdmission unchanged; trusted post-create/
pre-start delivery, pre-stop process capture, new-run/reset/quiescence and installed closure remain
work. Before ANY runtime/image action separately commit/independently accept exact packet, fresh
healthy Moss/resources and independently alive watchdog plus first healthy sample. Retain adopted
image/data/isolation/limits, hrtime1800s/heartbeat90s/sample5s/gap<10s/age<5s/equality/timestamps/log/
home limits and independent closure. Reuse accepted r21; r12/r18 causes unknown. Actual Node24/
128MiB/TigerVNC and real owner cookie/Origin/HTTPS/WSS/chat/fresh leases/live positive+hostile proof
remain required. No production deployment. A merged prerequisite never finishes owner delivery.
