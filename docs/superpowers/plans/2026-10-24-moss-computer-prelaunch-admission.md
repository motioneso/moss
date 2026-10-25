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
| `scripts/computer-watchdog/observe.ts:114-132`        | `assertFencedComputerState` (returns early without a lifetime, line 118) requires state resources to equal `binding.desktopId` and `binding.gatewayId`, which exist only after `docker.create`. |

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

Add a read-only prelaunch observation that reuses the existing sample fields without the pair:

- Same checks as `observeComputer` minus `checkComputerLogs` and the lifetime-binding half of
  `assertFencedComputerState`. The stop-marker check (observe.ts:128-132) is carried over, and
  admission also calls `assertLaunchable` (state.ts:164) at the check.
- Keeps Moss readiness, null outputs, trusted deployment revalidation, journal inspection, and
  the resource floors (RAM and root at least 8 GiB, data at least 30 GiB, home and socket
  under 10 GiB).
- Requires zero Computer resources in state and in the Docker inventory. A re-enable of a
  running pair therefore needs a disable first, on purpose.
- Carries a sample kind. The policy (`policy.ts`, exact key set near line 88) must reject a
  prelaunch sample explicitly, not by accident of the key set.
- Is bound to the state generation being admitted. The host bumps the generation (line 68)
  before admission runs, so the sample is taken after the bump and carries that generation.
  The watchdog writes it into the existing journal over the same private channel, and the host
  reads it from there. The run ID is bound to the watchdog identity when the sample is written.

Admission rules the later implementation must enforce, each with a removed-protection test:

1. Sample age under 5s at the check. Both processes use `computerMonotonicMs` (linux.ts). The
   host refuses rollback and a sample time in the future.
2. Watchdog identity (pid, start ticks, group) re-read at the check and equal to the sample.
3. Sample run ID and state generation equal the run being admitted.
4. A stop marker, latched stop, or stale generation refuses.
5. Age and the zero-resource fact are re-checked after the removal step and immediately before
   each create, because images, inventory and removal run between line 75 and line 100.
6. Post-launch sample within 10s of the prelaunch sample, or the run stops. This rule depends on
   the later handover contract and cannot be tested in this slice.

Limits stay as accepted: 1800s run, 90s heartbeat, 5s bootstrap bound, 5s age, gap under 10s.
Nothing here changes them.

This slice alone does not satisfy the BEFORE-launch gate. The watchdog that guards the run is
not yet the one admitted. Launch stays blocked until the handover contract is accepted.

## Out of scope

Handover protocol for option A, final pre-stop descendant reconciliation, installed delivery,
runtime packet, any launch. Each needs its own accepted contract.

## Gates for the later build

Independent Security and Standards/Spec acceptance of this plan, then of the exact final head.
Removed-protection failures observed and restored for each rule above. Full local gate through
the verify-gate skill. Green CI on the exact final head. No change to `unavailableAdmission`.
