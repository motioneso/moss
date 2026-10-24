# Computer Linux measurement prerequisite

Part of #3618/#3616/#3577. Pinned base `5897df5a7cfe127ba35f5e4ec2e7ed9d1a519409`
(merged policy PR#3642). Accepted policy source `708d6a585ed4e920c26f16d19bc4e6cf33c64763`.
Implementer: computer-supervised-watchdog. The [supervision dispatch](../handoffs/2026-10-24-moss-computer-supervised-watchdog.md)
authorizes independent review → resolve → exact checks/evidence/CI → merge → verified fresh
isolated successor until actual owner integration finishes. No production deployment.

## Bounded outcome and current seams

Implement the Linux measurement boundary first, before combining collection, independently running
scheduling, trusted health/log verification, receiving invalidation and Docker closure. It reads
actual Linux process/resource/filesystem state, never caller-supplied healthy flags. This is an
internal library, not running supervision or a complete admission sample. No executable, daemon,
Docker/image/guest/DB/browser/TCP operation, product capability or deployment requirement is added.
No replacement for unavailableAdmission and no standalone r21 persistence requalification.

Verified current seams (graph searches returned no coverage for scripts/computer-watchdog;
bounded source reads followed):

- `scripts/computer-watchdog/policy.ts:14-43,145-275` owns process/sample types and all fixed
  policy bounds. It consumes supplied metadata, has no Linux I/O/scheduler, and grants no launch.
- `scripts/computer-host/config.ts:52-116` owns RootIdentity and canonical root/ancestor inspection.
  HostStateStore in `state.ts:100-176` preserves durable roots, lock, full IDs and creation intents.
  New measurement must not take that lock, rewrite state, erase identities or infer recovery.
- `scripts/computer-host/operations.ts:11-21,74-92,133-162` owns deliberately unavailable launch
  admission and gateway-first cleanup. `scripts/computer-host.ts:26` keeps unavailableAdmission.
- `scripts/computer-host/spec.ts:20-79` fixes resource/log envelopes, but does not independently
  measure actual log growth, current health or complete resource closure.

A single large supervisor would grant authority while also inventing its collector and cleanup
path. Implementing a fixture-only resource predicate is smaller but cannot measure OS identities
or guest-controlled files. Choose a bounded real Linux collector, with no launch authority, and
carry the concrete supervisor/invalidation/closure work forward. Kill owner: computer-supervised-
watchdog; split/reject if this candidate starts processes, accepts supplied health/log booleans,
uses generic exec or wires admission. No UI/model work; later feedback derives from records.

## Exact collection contract

Files: `scripts/computer-watchdog/linux.ts`, `scripts/computer-watchdog/linux-files.ts`, and focused
`tests/unit/computer-watchdog-linux*.test.ts`. No dependency/manifest/lockfile change.
Consume WatchdogProcessIdentity/WatchdogProcessSample/WatchdogSample and COMPUTER_WATCHDOG_LIMITS.
Export `computerMonotonicMs(): number`, `readComputerProcess(identity): Promise<WatchdogProcessSample>`,
`measureComputerTree(root: RootIdentity): Promise<number>` and
`collectComputerLinuxMeasurements(configuration): Promise<ComputerLinuxMeasurements>`.
Configuration fixes runner/watchdog identities and pinned home/socket/data RootIdentity records.
Output contains only measuredAtMs, runner, watchdog, availableMemoryBytes, rootAvailableBytes,
dataAvailableBytes, homeBytes, socketBytes. It deliberately cannot satisfy WatchdogSample: runId,
Moss health, bounded-log proof and stopRequested are absent. No policy threshold duplication.

Full collection requires Linux and effective UID0, snapshots caller configuration before awaiting,
and uses the fixed host `/proc` mounted as procfs (statfs type0x9fa0). No alternate proc root,
exec/shell, supplied process state, injected production I/O or fallback measurements. The exported
read-only process/tree helpers do not require root and confer no trust/authority independently.
The later root-trusted supervisor must independently validate its configuration, filesystem/mount
namespace, trusted ancestors and recorded roots using the host machinery; calling a root-gated
collector does not establish that supervision. Configuration objects are trusted local code, not
browser/guest input. Capture plain scalar fields once and validate their numbers/strings.

Anchor measuredAtMs using hrtime.bigint milliseconds before the first I/O/measurement. All later
policy/driver calls must share this monotonic clock domain. Completion age >=5000ms rejects,
never restamp completed old I/O as fresh. No collector timer, renewal of heartbeat or admission.
A future scheduler must tick independently while collection hangs; host suspension/event-loop
scheduling cannot provide a hard real-time guarantee.

Read `/proc/<positive-safe-pid>/stat` with NOFOLLOW|NONBLOCK and bounded <=8192byte reads;
parse comm using its final closing parenthesis (comm can contain spaces/parentheses). Require
exact requested PID, positive safe process-group ID, decimal nonzero startTicks up to20digits,
and live R/S/D state; stopped/zombie/dead/reused/replaced/missing identities reject. Check both
runner and watchdog before and after the resource scan; identities must differ in PID and group.
This is repeated OS observation, not a guarantee of continued liveness after return. Read only
fixed `/proc/meminfo` <=65536bytes; exactly one decimal MemAvailable kB, convert with bigint,
reject malformed/duplicate/missing/unsafe values. No free-memory fallback or unit guessing.
Use bigint statfs bavail\*bsize for `/` and pinned data directory; reject negative/unsafe products.
Data root opens O_DIRECTORY|NOFOLLOW and must match pinned dev/ino/uid/gid/mode; read statfs via
its descriptor path so a renamed path cannot substitute another filesystem. Recheck pinned paths
before returning. All failures throw a fixed sanitized measurement error; never report zero/healthy.

Tree accounting opens pinned home/socket directories O_DIRECTORY|NOFOLLOW and verifies recorded
identity. Traverse through `/proc/self/fd/<open-directory-fd>/<entry>`, opening child directories
NOFOLLOW before traversing; never concatenate unchecked guest paths to operator roots. Stream
entries with opendir, depth<=32 and <=100000 entries across a tree. Reject cross-device entries,
identity changes, read errors and scan-budget exhaustion; close every handle/iterator on failure.
Reject directory entry names containing U+FFFD (conservative invalid-UTF8 refusal), slash, NUL,
or dot/dotdot before constructing any descriptor-relative path. Node string decoding must never
map distinct invalid-byte names onto a smaller replacement-character sibling. Include a real
Buffer-path invalid-UTF8 filename/sibling regression and an observed removed-name-guard failure.
Count every entry conservatively using max(logical size, blocks\*512,4096), including directories,
symlink inode storage and repeated hardlinks. Do not follow symlinks or open file/FIFO/device/socket
contents. Permit ordinary Unix sockets and FIFOs as metadata. Reject device nodes. Compare child
directory identity after open and root pathname identity before/after collection. Use bigint and
reject unsafe totals. Hardlinks count repeatedly; sparse logical bytes count. This is bounded
sampled accounting, not a filesystem snapshot, quota or proof against writes after observation.
The future supervisor must also verify actual logs/receipts bounds and independent health.

## Verification and evaluation

Search Hindsight test conventions first. Inspect cache/install first; scoped frozen installation
includes root, API/workspace, worker/workspace, web and visual-chat spike dependencies. No DB or
foundation command is needed; any later DB command requires verify-gate and an isolated target.
Unpiped commands, expected exit0, private logs outside ~/Jarv1s:

- Focused new Linux tests plus existing policy and host/client regression suites.
- `pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.tests.json --noEmit`.
- Scoped ESLint max-warnings0, Prettier, `pnpm check:file-size`, `git diff --check`.

Exercise real Linux /proc for current/child process identities, distinct process groups, exact
replacement rejection and stopped/dead child refusal. Ordinary short-lived test children are
allowed, never watchdog/guest/runtime launch. Exercise real temporary trees with symlinks to
large external files, sparse files, hardlinks, FIFOs/socket metadata, renamed/replaced roots,
file/directory replacement during traversal, depth/entry/size budgets and actual descriptor
closure. Fault injection with test-only spies covers malformed/oversized proc input, statfs
negative/overflow/cross-device failures, delayed collection preserving initial time, root gate,
late identity change and safe-integer limits. Complete collection may mock only effective UID
and fixed read results for deterministic fixtures; disclose that it is not root deployment proof.
Verify returned fields feed the actual policy only after explicitly disclosed fixture health/log/
run/stop fields are supplied; this does not count as independent runtime admission.
Observe removed-protection tests fail at intended identity, nofollow/pinned-root, resource parsing
and original-timestamp assertions. Restore exact bytes and rerun full green; retain every attempt.
This executed read-only collector is the internal slice's end-to-end seam, not live owner proof.

Independent read-only security/spec acceptance of this committed plan precedes code. Afterwards
independent Standards+Spec review at pinned base and security review, resolve findings, exact final
evidence and required green CI before merge. Preserve every review round and failed attempt.

## Required continuation: no launch permission

Next implement the real root-trusted independently running watchdog/scheduler and trusted complete
sample composition, synchronous receiving invalidation, durable stop intent and independent closure.
Explicit unresolved-intent recovery must preserve lock/root identities, request CAS, full immutable
IDs/creation generations and failed-cleanup identities. Only known-ID container inspect404 proves
absence; disable gateway first, retain home, never delete volumes. API gets no Docker/devices/
generic exec/guest socket. unavailableAdmission stays unavailable until this whole boundary is
independently accepted. Monitoring is not quota.

Before ANY image/runtime operation: separately committed exact packet independently accepted,
fresh healthy Moss and RAM/root>=8GiB/data>=30GiB, independent alive watchdog first complete
healthy sample, exact labels/PID/start/group, <=1800s monotonic run, <=90s heartbeat, nominal5s
samples, sample gap<10s and receipt age<5s, fail closed on missing/failed measurements/logs/floors/
home+socket>=10GiB. Inspect all samples/reasons and independently verify exact closure/healthy Moss.
Reuse adopted exact guest image/protected dedicated data; guest UID1000/network-none/2CPU/4GiB/
512PIDs, separate gateway UID1000/network-none/0.5CPU/128MiB/32PIDs, RO roots, dropped caps,
no-new-privileges/default profiles, bounded tmpfs/logs, no gateway home mount. Claim devports5180–
5299 for servers. No unrestricted bridge, production restart/data substitution or deployment.

Packaging is not a qualified built gateway image/Node24/128MiB fit. Qualify exact image/start-stop/
Unix mounts/auth invalidation and actual adopted TigerVNC Fence, fixed lifecycle and independent
closure before installed #3618 usability. Then #3619 ordinary owner cookie/exact Origin before
upgrade, fixed binding/private viewer IDs, trusted bundled assets, approved concise chat/browser
layout and real trusted API-to-gateway agent leases. Preserve sole writer/predecoder bounds,
absolute deadlines, synchronous retirement, epochs, pressed releases, matching BlockBefore Fence,
fresh post-Fence auth and stable control separate from replaceable raw RFB. No credential/viewer
IDs in URLs or guest mounts. App-map and affected dev/prod config accompany product wiring.
Actual login→chat/browser→frame/input→takeover→return/intentional-close, hostile/expired/revoked
sessions, watcher isolation, unexpected-loss pause and stale/pressed input need independent exact
live evidence/closure before #3616/#3577 closes. Idle sleep/wake, confined useful Internet egress
and platform/release remain separately bounded. Keep all parent issues open. After actual merge
launch/verify a fresh isolated successor with the same continuing instruction via herdr-handoff;
record durable routing name plus actual session UUID and handoff-read execution.

## Review rulings

Independent read-only security/spec R1 on `600090a39`: BLOCKED. Accepted: default UTF8
directory-name decoding can alias a large invalid-byte filename to a small literal U+FFFD sibling,
undercounting the tree. Conservatively reject all U+FFFD entry names before constructing paths;
add a real raw Buffer-path collision regression and removed-guard control. No disputed findings.
Exact amended plan requires independent acceptance before implementation.
