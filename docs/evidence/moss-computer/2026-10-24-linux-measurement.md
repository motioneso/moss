# Linux watchdog measurement prerequisite

Part of #3618/#3616/#3577. Base `5897df5a7cfe127ba35f5e4ec2e7ed9d1a519409`, merged policy
PR#3642. Exact source `45820eda5ca9cd5a5b6c0e3645318a323a594aac`; amended plan
`30fb5c168df1578edc88c472bb172571e0449d92`. [Machine-readable receipts](2026-10-24-linux-measurement.json)
record exact commands, exits, elapsed times, source/restoration/log hashes and all review rounds.

## Result and boundary

The new read-only Linux library observes exact process PID/start/group/live-state identities,
MemAvailable, available root/data bytes and bounded descriptor-relative home/socket accounting.
It anchors monotonic time before I/O, refuses stale completion, pins root identities and refuses
lossy UTF8 filename aliases. Its result deliberately lacks run ID, health, log and stop proof and
cannot satisfy a complete WatchdogSample or grant launch. Full collection requires effective UID0;
that check does not establish trusted deployment or mount/process namespace/config/ancestor trust.

No executable, running supervisor, timer, full health/log measurement, receiving invalidation,
durable stop/recovery/cleanup or independent closure is implemented. unavailableAdmission,
host operations/spec, policy, dependency manifests and lockfile are unchanged. No product surface,
deployment requirement or app-map change follows. All owner parent issues remain open. Accepted
r21 persistence is reused without requalification; original r12/r18 causes remain unknown.

## Executed checks

The final restored suite passed **199 tests across five files**: new process/tree suites plus
existing policy and host/client regressions. Root TypeScript and tests TypeScript, scoped ESLint,
Prettier, file-size and whitespace checks exited0. Committed source/test/plan hashes match the
restored control bytes and final working tree. JSON retains earlier successful runs as well.

Tests read actual Linux /proc for current/detached/stopped/dead process identities, use actual
temporary trees/descriptors with sparse files, repeated hardlinks, symlinks, FIFO and Unix socket
metadata, invalid-byte filenames and replacement roots/directories. Budget, malformed proc,
cross-device, unsafe-byte and delayed-time cases use disclosed test spies. Full collection tests
spy effective UID, process/memory/disk reads and clock while retaining actual temp trees; policy
composition explicitly supplies fixture health/log/run/stop fields. This is not actual root
deployment, supervision, resource admission, sustained fit, image or owner acceptance. Existing
host/client tests use recording Docker HTTP stand-ins. No Docker/image/guest/DB/browser/TCP server
or production operation occurred. Ordinary short-lived test children and private Unix fixtures
were closed and temporary trees removed.

Initial behaviorR1 failed (23 failures/8 passes): native namespace spying could not redefine
fs.open. A test-only vi.mock facade corrected the harness; R2 passed31 tests, and R3/final passed199.
No production fallback was added. Frozen offline installation included root/API/worker/web/spike
scope after cache inspection; exact command and install log hash are in JSON.

## Observed removed-protection controls

Each control exited1 at its intended assertion; every source file was restored byte-for-byte:

| Removed protection                      | Observed failure                                             |
| --------------------------------------- | ------------------------------------------------------------ |
| Exact process startTicks comparison     | Changed start identity accepted instead of rejected          |
| Directory O_NOFOLLOW                    | Same-inode child symlink followed; measurement8192 accepted  |
| Root identity comparison                | Replacement root measurement4096 accepted                    |
| Unique MemAvailable requirement         | Duplicate memory field admitted                              |
| Original returned measurement timestamp | Returned5999 instead of initial1000                          |
| Replacement-character filename guard    | Invalid-byte/small-U+FFFD collision undercount12288 accepted |

The symlink control preserves the originally observed directory inode behind the replacement
symlink, so inode comparison alone cannot make this test pass after removing NOFOLLOW. The UTF8
control uses a real raw FF filename containing1000000 logical bytes and a small literal U+FFFD
sibling, reproducing the lossy-name alias that independent plan review identified.

## Independent review and continuation

PlanR1 (`600090a39`) was BLOCKED for invalid-UTF8 alias undercount. The accepted amendment requires
conservative U+FFFD refusal before lookup and an actual filename regression/removed-guard control.
PlanR2 accepted `30fb5c168`. No disputed findings remain. Independent source Standards, Spec and
security R1 accepted exact `45820eda5`, with zero findings/blockers. Every report's immutable hash
is retained in JSON; private raw reports/logs remain in the sibling supervision directory.

Independent exact final evidence acceptance and exact required green CI are separate premerge
gates. The [successor dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-trusted-supervisor.md)
carries the authorized independent review→resolve→exact checks/evidence/CI→merge→verified fresh
isolated successor chain until actual owner integration finishes. No production deployment.

Next implement root-trusted independently running scheduling and complete trusted health/log
composition, synchronous receiving invalidation, durable stop intent, explicit unresolved-intent
recovery and independently verified exact closure. Preserve lifecycle lock/root identities/full
IDs/creation generations/request CAS/failed-cleanup identities. Only known-ID container inspect404
reconciles absence; disable fences gateway first and retains home. API gets no Docker/devices/
generic exec/guest socket. unavailableAdmission stays unavailable until the complete boundary is
independently accepted. Monitoring is not quota and no hard real-time guarantee follows from host
suspension or event-loop scheduling.

Before ANY image/runtime operation: separately committed exact packet independently accepted,
fresh healthy Moss, RAM/root>=8GiB/data>=30GiB, independent alive watchdog with first complete
healthy sample, exact labels/PID/start/group, <=1800s monotonic run, heartbeat<=90s, nominal5s
samples, gap<10s, receipt age<5s and fail-closed measurement/floor/log/home+socket>=10GiB stop.
Inspect every sample/reason and independently verify exact closure/healthy Moss. Use adopted
exact guest image/protected dedicated data and all inherited fixed resource/isolation gates.
Packaging alone is not a qualified gateway image/Node24/128MiB/TigerVNC/lifecycle proof. Owner
HTTPS/WSS/revocation/chat/agent-dispatch and live acceptance remain open; a merged prerequisite
does not complete #3616/#3577.
