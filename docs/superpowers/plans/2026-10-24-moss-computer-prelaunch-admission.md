# Computer prelaunch admission contract

Plan only. No code, no runtime, image, Docker, deployment or production operation. `unavailableAdmission`
stays the only admission in the tree. Parents #3577, #3616, #3617, #3618 and #3619 stay open.

## Problem

The handoff chain requires an independently alive watchdog and a first complete healthy sample
BEFORE any launch ([bootstrap-health plan](2026-10-24-moss-computer-bootstrap-health.md), "Exact
bootstrap contract"). The tree has no such gate. Three sources show why.

| Source                                               | Fact                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/computer-host/operations.ts:11-21,86-93`    | `ComputerRuntimeAdmission.assertAdmitted()` runs after the generation bump and before `docker.create`. It is the only launch seam.                 |
| `scripts/computer-watchdog/observe.ts:57-60,121-126` | `checkComputerLogs` refuses unless the pair is already running when `config.lifetime` is set.                                                      |
| `scripts/computer-watchdog/observe.ts:105-133`       | `assertFencedComputerState` requires state resources to equal `binding.desktopId` and `binding.gatewayId`, which exist only after `docker.create`. |

So the sample the watchdog produces today can only be taken after launch, and its run
configuration (binding with container IDs) cannot be pinned before launch. A launch gate that
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

Add a read-only prelaunch observation that reuses the existing sample fields without the pair:

- Same checks as `observeComputer` minus `checkComputerLogs` and `assertFencedComputerState`.
- Keeps Moss readiness, null outputs, trusted deployment revalidation, journal inspection, and
  the resource floors (RAM and root at least 8 GiB, data at least 30 GiB, home and socket
  under 10 GiB).
- Requires zero Computer resources in state and in the Docker inventory.
- Produces a distinct sample kind so it can never satisfy the post-launch policy.

Admission rules the later implementation must enforce, each with a removed-protection test:

1. Sample age under 5s at the check, measured on the monotonic clock, no rollback.
2. Watchdog identity (pid, start ticks, group) re-read at the check and equal to the sample.
3. Sample run ID equals the run being admitted.
4. A post-launch sample must arrive within 10s of the prelaunch sample or the run stops.
5. Any stop marker, latched stop, or stale generation refuses.

## Out of scope

Handover protocol for option A, final pre-stop descendant reconciliation, installed delivery,
runtime packet, any launch. Each needs its own accepted contract.

## Gates for the later build

Independent Security and Standards/Spec acceptance of this plan, then of the exact final head.
Removed-protection failures observed and restored for each rule above. Full local gate through
the verify-gate skill. Green CI on the exact final head. No change to `unavailableAdmission`.
