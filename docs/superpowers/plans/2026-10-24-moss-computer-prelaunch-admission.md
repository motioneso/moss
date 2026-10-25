# Computer prelaunch admission contract

Plan only. No code, no runtime, image, Docker, deployment or production operation. `unavailableAdmission`
stays the only admission in the tree. Parents #3577, #3616, #3617, #3618 and #3619 stay open.

## Problem

The handoff chain requires an independently alive watchdog and a first complete healthy sample
BEFORE any launch ([bootstrap-health plan](2026-10-24-moss-computer-bootstrap-health.md), "Exact
bootstrap contract"). The tree has no such gate. Three sources show why.

| Source                                                | Fact                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/computer-host/operations.ts:11-21,68,75,100` | `ComputerRuntimeAdmission.assertAdmitted()` runs at line 75, after the generation bump (line 68) and before `docker.create` (line 100). It is the only launch seam.                             |
| `scripts/computer-watchdog/observe.ts:65-71`          | `checkComputerLogs` refuses unless the pair is already running when `config.lifetime` is set (line 71).                                                                                         |
| `scripts/computer-watchdog/observe.ts:114-132`        | `assertFencedComputerState` (returns early without a lifetime, line 119) requires state resources to equal `binding.desktopId` and `binding.gatewayId`, which exist only after `docker.create`. |

A run configuration without a lifetime already skips both checks. What is missing is a
configuration that carries the lifetime binding AND exists before create. The binding holds
container IDs, so a lifetime-bound sample can only be taken after launch. A launch gate that
reuses this sample is circular. A gate that skips the sample is not the accepted ordering.

## Fork to decide before code

| Option                                 | Mechanism                                                                                                                                                                                     | Cost                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A. Two-phase watchdog                  | One watchdog process starts with a prelaunch configuration (no binding). It samples host-only facts, publishes them, and admission reads them. After create, a second bound phase takes over. | Needs a pinned handover from phase one to two with no gap over 10s. New delivery protocol for the bound configuration.            |
| B. Prelaunch probe plus fresh watchdog | A separate short probe proves host-only health and a live watchdog slot. The real watchdog starts after create, as today.                                                                     | The "alive BEFORE launch" requirement is met only by the probe, so the watchdog guarding the run is not the one admitted. Weaker. |
| C. Pre-allocated identities            | Container IDs cannot be chosen before create, so reject.                                                                                                                                      | Docker assigns IDs.                                                                                                               |

Recommendation: A, with the handover as its own later contract. This plan accepts only the
host-only half of A (below), because it is independently testable and changes no lifecycle
ordering.

## Bounded contract: host-only prelaunch sample

The lifecycle order in `operations.ts` does not change. Admission (line 75) still runs before the
image check (81), the inventory check (86), the already-running return (88-92) and the removal step
(94). A refused or missing sample therefore also refuses a re-enable of a running pair. That is
fail-closed on purpose.

Add a read-only prelaunch observation that reuses the existing sample fields without the pair:

- Same checks as `observeComputer` minus `checkComputerLogs` and the lifetime-binding half of
  `assertFencedComputerState` (which returns early without a lifetime, observe.ts:119). The stop-marker
  check (observe.ts:133-139) and the enabled check (observe.ts:122) sit behind that early return, so
  the build moves them into a function that runs without a lifetime, and admission also calls `assertLaunchable`
  (state.ts:164) at the check.
- Keeps Moss readiness, null outputs, trusted deployment revalidation, journal inspection, and
  the RAM, root and data floors (RAM and root at least 8 GiB, data at least 30 GiB). The home and
  socket cap is measured on the prepared roots, which exist before create, and may be near zero.
- Makes no claim about Computer resources. The host checks resources itself, fresh, at the points
  listed in rule 5.
- Carries its kind as a separate top-level key. The post-launch parser (`policy.ts`, exact
  `sampleKeys` at lines 65-77, `fields` at 85-95, parse at 207) stays exact, so a prelaunch sample
  fails it on shape. Removed-protection tests feed a prelaunch sample to the post-launch parser, and a post-launch
  sample or a sample file left from before a reboot to the prelaunch parser. The prelaunch parser
  is exact on keys and values. `computerMonotonicMs` is Linux `process.hrtime`, which is shared by
  all processes on one boot and restarts from zero at each boot, so age alone cannot reject a sample from an earlier boot. The sample carries the trusted boot ID (trust.ts:35), and the prelaunch parser refuses any other. A test removes that check.
- Is anchored at first I/O. `measuredAtMs` is read before any observation I/O and never freshened,
  as in `observeComputer` (observe.ts:147). Equal timestamps refuse, as the bootstrap plan requires.

Where values come from. `assertAdmitted()` takes no arguments (operations.ts:12), so the admission
implementation is constructed with the host store and the pinned deployment configuration
(`trust.ts`). That configuration pins the run ID (trust.ts:27) and the runner identity (trust.ts:28).
It pins no watchdog identity, and `observeComputer` receives the watchdog as an argument
(observe.ts:145). The sample therefore cannot be checked against a trusted watchdog identity today.
The build must add one trusted source for it, either a new pinned field or a value recorded by the
supervisor when the watchdog starts, and this plan leaves that choice to the handover contract.
Until it exists, rule 2 is not satisfiable and admission stays unavailable.

The run ID, the pinned runner and the generation being admitted come from the host store and the
pinned configuration, never from the sample.

Sample file checks. `assertRoot` (linux-files.ts:37-43) only matches a recorded directory identity
and real path. It does not check owner or mode. The sample file must also pass the journal's file
rules (journal.ts:47-48): regular file, owner equal to the root identity's owner, mode 0600, one
link, size under a fixed cap, and no symlink. The plan makes no wider security claim. The build
must prove each check with a forged-sample test that fails when the check is removed.

Admission rules, each with a removed-protection test:

1. Sample age under 5s, by `computerMonotonicMs` (linux.ts, `process.hrtime`), which is shared by
   all processes within one boot. Age is checked twice: at `assertAdmitted` (operations.ts:75) and
   again immediately before the desktop create (line 100). Images, inventory and removal run
   between them (lines 81-94). A sample older than 5s at either point refuses, and the owner
   retries. That is fail-closed. Refuse rollback, a future sample time, and equal timestamps.
2. Watchdog identity (pid, start ticks, group) re-read at the check and equal to the pinned
   identity and the sample.
3. Sample run ID equals the pinned run ID. Sample generation equals the generation after the bump
   (line 68). The bump is saved at lines 66-70 before admission runs, so the watchdog must produce
   the sample after the bump. How admission obtains a fresh sample (wait or request) and how it
   reaches the launch guard are open items for the handover contract.
4. A stop marker, latched stop, or stale generation refuses.
5. A fresh host-side inventory check, never the sample's word, runs after the removal step. It is
   new code in the store's launch guard (docker.ts:50-52, operations.ts:32-35), which today calls
   only `assertLaunchable` and `assertNotStopped`. Before the desktop create it requires no
   resources. Before the gateway create (after the desktop start, line 105) it requires only this
   generation's desktop. Another actor could still create a container between a check and its
   create. Only the host's busy flag (operations.ts:51) covers that, and it covers this process
   only. The build adds a check after each create that the inventory holds exactly the expected
   containers.
6. A sample is single use. Admission consumes it at the desktop create, and the gateway create
   does not re-read it. The consumed hash is stored durably before the desktop create so a host
   restart cannot replay the sample inside its 5s window. The host state file accepts exactly
   `enabled,generation,resources` (state.ts:62), so the build needs a new private record file,
   which is an open item for the handover contract. A test proves the gateway create stays
   reachable on a healthy run.
7. A missing, unreadable, oversized or malformed sample refuses, one test per case.
8. Post-launch sample within 10s of the prelaunch sample, or the run stops. This rule depends on the
   later handover contract and cannot be tested in this slice.

Limits stay as accepted: 1800s run, 90s heartbeat, 5s bootstrap bound, 5s age, gap under 10s.
Nothing here changes them.

This slice alone does not satisfy the BEFORE-launch gate. The watchdog that guards the run is
not yet the one admitted. `unavailableAdmission` stays the only admission until the handover
contract is accepted, and launch stays blocked until then.

## Out of scope

Handover protocol for option A, final pre-stop descendant reconciliation, installed delivery,
runtime packet, any launch. Each needs its own accepted contract.

## Gates for the later build

Independent Security and Standards/Spec acceptance of this plan, then of the exact final head.
Removed-protection failures observed and restored for each rule above. Full local gate through
the verify-gate skill. Green CI on the exact final head. No change to `unavailableAdmission`.
