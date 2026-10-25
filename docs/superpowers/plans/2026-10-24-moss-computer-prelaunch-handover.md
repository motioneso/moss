# Computer prelaunch handover contract

Plan only. No code, no runtime, image, Docker, deployment or production operation.
`unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and #3619 stay
open. This settles the open items in the
[prelaunch admission plan](2026-10-24-moss-computer-prelaunch-admission.md): the trusted watchdog
identity, the fresh-sample path, the used-sample record and the boot ID source, for the prelaunch
phase only. The handover to the bound second phase and the first healthy sample stay open (below).
The limits stay as accepted and unchanged: 1800s run, 90s heartbeat, 5s bootstrap bound, 5s sample
age, gap under 10s. The gap rule needs the second phase and is deferred with it.

## Facts from the tree

| Source                                                                                     | Fact                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/computer-watchdog.ts:22,34-36,74-75`                                              | The watchdog refuses to share a pid or process group with the pinned runner. Modes are `observe`, `fence`, `manage` and `collect`. `observe` rejects a lifetime and `manage` needs one.            |
| `scripts/computer-watchdog.ts:39-71`                                                       | `collect` is a one-shot. It reads one bounded JSON record on stdin with exactly the keys `configSha256`, `runId` and `watchdog`, runs `observeComputer`, and writes one sample to stdout (16 KiB). |
| `scripts/computer-watchdog/trust.ts:169-175`                                               | The watchdog and its sampler require uid 0 and an empty `execArgv`. They hash their own artifact against the pinned configuration (trust.ts:275).                                                  |
| `scripts/computer-watchdog/supervisor.ts:58-100`                                           | The supervisor spawns the collector with empty environment and stdio pipe, pipe, ignore (lines 66-68), and reads the sample over a pipe it owns.                                                   |
| `scripts/computer-watchdog/trust.ts:27-28,35,236-246`                                      | The pinned configuration holds the run ID, runner identity and boot ID. `processIdentity(pid)` reads pid, group and start ticks from `/proc`.                                                      |
| `scripts/computer-watchdog/linux.ts:76-95`                                                 | `readComputerProcess` proves a process with that pid and start ticks exists in state R, S or D. It does not prove which program it runs.                                                           |
| `scripts/computer-host/operations.ts:66-70,75,97-106`, `scripts/computer-host/config.ts:7` | Bump at 66-70, admission at 75, then images, inventory and removal. The create loop runs gateway first, then desktop. Each create is followed by a start.                                          |
| `scripts/computer-watchdog/observe.ts:119`, `scripts/computer-host/operations.ts:12`       | Without a lifetime the observation skips the pair and fence checks. `assertAdmitted()` takes no arguments.                                                                                         |

## Decision: the launcher spawns the pinned watchdog and a one-shot sampler

Independence is the point of the watchdog, so admission must not sample itself in the launching
process. The contract reuses the pipe model the supervisor already uses.

### Pins

The launcher must run as root, because the sampler requires uid 0 (trust.ts:169-175). The host
tool already runs as the owner of the managed state (state.ts:36), but no source shows that it is
root. Running it as root is an assumption this plan adds, and the build must prove it or refuse to
start. The launcher loads the same pinned deployment configuration the watchdog loads, with the same
loader, and takes the node path, artifact path, artifact hash, config path, config hash and run ID
from it. Nothing in a request or a sample supplies an expected value. Before every spawn the
launcher checks the node and artifact paths with `assertTrustedPath` and the artifact hash, as
`computer-watchdog.ts` does at startup. A replaced binary fails that check. Root on the box is the
trust boundary, as it is for the existing supervisor, and this plan claims nothing beyond that.

### 1. Watchdog identity source

`manage` mode needs a lifetime binding (computer-watchdog.ts:34), and the binding holds container IDs that
exist only after create. A `manage` watchdog therefore cannot exist before launch. The prelaunch
phase needs a lifetime-free long-running mode, called `hold` here. It starts under the pinned
configuration without a lifetime, refuses a lifetime like `observe`, keeps the process and its
single-instance guard alive, and does no fencing. Adding `hold` is part of the build. The move from
`hold` to a bound `manage` watchdog after create is the second phase and stays open below.

1. When the launcher starts, before any enable request and outside the enable path, it spawns the
   `hold` watchdog with fixed argv and empty environment. Lifecycle order in `operations.ts` does
   not change.
2. Immediately after spawn it reads the identity with `processIdentity` and also reads
   `/proc/<pid>/exe` and `/proc/<pid>/cmdline`. Both must equal the pinned node path, artifact path
   and config path. A process running some other program fails here.
3. The child handle must show no exit or signal (`exitCode` and `signalCode` null) at that read and
   again at each admission read. The build must confirm by reading Node's behavior that an exited
   child is reaped, so that this check closes pid reuse between the reads.
4. The identity stays in launcher memory. The sample is never its source.
5. If the launcher restarts it holds no identity and refuses to admit until it spawns a new `hold`
   watchdog. What happens to a `hold` watchdog left by the earlier launcher is not settled here. It
   belongs to the delivery contract, and until then admission stays refused.

This proves the launcher started the pinned program and that it is still the same process. It does
not prove the watchdog is healthy. Health stays with the first complete sample item below.

### 2. Fresh-sample path

1. After the bump, `assertAdmitted` spawns a one-shot sampler in a new `prelaunch` mode. `collect`
   keeps its exact three-key request and is not changed.
2. The request on stdin has exactly the keys `configSha256`, `runId`, `watchdog`, `generation` and
   `nonce`. The generation is the one just saved. The nonce is 128 bits from
   `crypto.randomBytes`, travels only on stdin and is never logged.
3. The sample returns on the sampler's stdout pipe, which only the launcher holds. The sampler
   compares the request's config hash and run ID with the config it loaded, as `collect` does, but
   the launcher already took those values from the pin, so the comparison is a second check and not
   the source of trust.
4. The sample is a separate record kind with its own exact-key parser. The post-launch parser stays
   exact and rejects it on shape.

### 3. Used-sample record

1. The nonce is single use and lives in launcher memory. The sample echoes the nonce, the
   generation and the boot ID. The expected boot ID is the pinned one (trust.ts:35).
2. A new spawn and nonce are needed for each admission. The fresh child on a private pipe is what stops replay. The nonce adds a second check that a record belongs to this request, and it is a real protection only against a record from another request or an earlier run. Bytes from an earlier pipe cannot match.
   A launcher restart drops the nonce, so an old sample has no matching request.
3. The launcher marks the sample consumed in memory at the first create (gateway). The second
   create and both starts do not read the sample again. This replaces rule 6 of the admission plan,
   which asked for a durable consumed hash in a new file. The host state file stays unchanged
   (state.ts:62). The admission plan's sample-file checks and its separate top-level kind key are
   superseded because no file exists. The kind stays as a field in the pipe record.
4. Corrections to the admission plan. Its rules 1 and 6 say "desktop create", but the create loop
   makes the gateway first (config.ts:7, operations.ts:97), so every "desktop create" there means
   the first create. Its rule 2 "pinned identity" means the identity held in launcher memory by
   decision 1. Its rule 7 is covered by launcher rules 5 and 6 below. Its rule 5 has the same inversion (it names the desktop create first), so its first-create check
   applies before the gateway and its second-create check before the desktop. Its rules 3 and 4
   stand. The sample also echoes the watchdog identity, and the launcher compares it with the
   identity it holds, so rule 2 keeps its comparison with the sample.

## Sampler contract

- Same host-only observation as the admission plan, including the stop-marker and enabled checks
  moved out of the lifetime early return, and the floors RAM and root at least 8 GiB and data at
  least 30 GiB.
- Re-reads the supplied watchdog identity with `readComputerProcess` and refuses a dead or replaced
  process. This adds liveness only. The launcher's own checks in decision 1 carry the identity
  claim.
- Reads `measuredAtMs` before any I/O. Output is one exact-key record under 16 KiB. Extra keys, a
  second record or trailing bytes refuse.
- Hard wall-clock limit well under 5s. The launcher kills it on timeout and refuses.
- Both spawns (the `hold` watchdog and the sampler) use a fixed argv, empty environment, no shell,
  and stdio pipe, pipe, ignore for the sampler and ignore for the watchdog. The watchdog is spawned
  detached so it has its own process group, and the build refuses a watchdog that shares a pid or
  group with the pinned runner (computer-watchdog.ts:74-75). A test removes each of these.
- The artifact hash is checked before spawn, not on the running image. A swap between the check and
  the spawn is possible for a writer with root, and root is the stated trust boundary.

## Launcher rules, each with a removed-protection test

Rules 1 to 7 test the launcher against a fake sampler. Rule 8 tests the real sampler, because a fake
cannot prove the real one works.

1. Binary pin. A node path, artifact path or artifact hash that differs from the pin refuses before
   spawn.
2. Identity. A process whose exe or cmdline is not the pinned program refuses. A child handle that
   shows an exit refuses. Two reads that differ refuse. A test replaces the child with a different
   process that holds the same pid after the original exited, and it must refuse.
3. A sample with a wrong nonce, generation, run ID or boot ID refuses, one test per field.
4. Age. Both processes read `computerMonotonicMs`, the system-wide monotonic clock (linux.ts:41-42),
   which is shared on one boot. The launcher reads T0 before spawning the sampler and T1 when it
   takes the sample. The sample's `measuredAtMs` must satisfy T0 < measuredAtMs <= T1 and
   T1 - measuredAtMs < 5s. A sample at or before T0 (stale or equal) refuses, and so does one after
   T1. The check runs at `assertAdmitted` and again immediately before the first (gateway) create,
   where the age is measured against a fresh read of the clock. Images, inventory and
   removal run between them (operations.ts:81-94), so a slow removal cannot get a re-sample. It can
   only refuse, and the owner retries.
5. A malformed, oversized, truncated or duplicated record refuses, one test per case.
6. A sampler that exits non-zero or hangs refuses. Stderr is ignored (supervisor.ts:66-68), so it
   carries no verdict.
7. Two concurrent admissions each get their own nonce and neither accepts the other's sample. A
   consumed sample cannot admit a second launch, and the second create still proceeds on a healthy
   run after the sample is consumed. One test each, with the consume mark removed.
8. Real sampler. The stop marker, the enabled check, each floor, a dead watchdog and the nonce echo
   each refuse, with the protection removed in turn and the failure observed.

## Still open, and why launch stays blocked

- The prelaunch runner. The pinned loader requires a live runner with null stdout and stderr
  before it will load any configuration, and for a non-collector process also a heartbeat pipe from
  that runner (trust.ts:331-334). Both `hold` and the `prelaunch` sampler go through that loader.
  What the pinned runner is before launch, and who supplies its heartbeat pipe, is not settled here.
  Decisions 1 and 2 depend on it, so this plan fixes their shape and not their satisfiability.
- The `hold` startup acknowledgement. The watchdog exits after 5s unless startup is acknowledged
  (computer-watchdog.ts:12-17), and today only the `manage` and supervise paths acknowledge. The
  build must define the condition on which `hold` acknowledges and stays alive. A test shows it
  survives past 5s and that removing the acknowledgement kills it at 5s.
- The bound second phase. After create the watchdog needs a configuration that carries the container
  IDs, and the post-launch loader requires that configuration to be pinned before use. Where the
  binding comes from, without letting the host mint its own trust, is the next contract. Rule 8 of
  the admission plan (post-launch sample within 10s) depends on it.
- The first complete healthy sample from the long-running watchdog's own journal before launch.
  This plan checks that the process the launcher started is still the same process. It does not
  check that the watchdog has finished a sample cycle.
- Installed delivery of the watchdog and sampler binaries, orphan cleanup, and any runtime packet.
- Launch therefore stays blocked on the open items above. No part of this plan is buildable until
  the prelaunch runner is settled.

No security claim here goes beyond what the build proves with the tests above. The claim that only
the launcher holds the pipe must be confirmed by reading how Node spawns the child before it is
relied on. The build opens the pipes itself and sets no inheritance of other descriptors.

## Gates for the later build

Independent Security and Standards/Spec acceptance of this plan and of the exact final head.
Removed-protection failures observed and restored for each rule above. Full local gate through the
verify-gate skill. Green CI on the exact final head. No change to `unavailableAdmission`.
