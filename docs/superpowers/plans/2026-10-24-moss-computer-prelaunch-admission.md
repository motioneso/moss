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
  check (observe.ts:133-139) is carried over, and admission also calls `assertLaunchable`
  (state.ts:164) at the check.
- Keeps Moss readiness, null outputs, trusted deployment revalidation, journal inspection, and
  the RAM, root and data floors (RAM and root at least 8 GiB, data at least 30 GiB). The home and
  socket cap is measured on the prepared roots, which exist before create, and may be near zero.
- Makes no claim about Computer resources. The host checks resources itself, fresh, at the points
  listed in rule 5.
- Carries its kind as a separate top-level key. The post-launch parser (`policy.ts`, exact
  `sampleKeys` at lines 65-77, `fields` at 85-95, parse at 207) stays exact, so a prelaunch sample
  fails it on shape. A removed-protection test feeds a prelaunch sample to the post-launch parser.
- Is anchored at first I/O. `measuredAtMs` is read before any observation I/O and never freshened,
  as in `observeComputer` (observe.ts:147). Equal timestamps refuse, as the bootstrap plan requires.

Where values come from. `assertAdmitted()` takes no arguments (operations.ts:12), so the admission
implementation is constructed with the host store and the pinned deployment configuration that the
watchdog also loads (`trust.ts`). The run ID, the expected watchdog identity and the generation
being admitted come from those, never from the sample. The sample is read from the watchdog's
journal directory, which must pass the existing root-owner and mode checks (`assertRoot`). The
plan makes no wider security claim. The build must prove it with a forged-sample test.

Admission rules, each with a removed-protection test:

1. Sample age under 5s at the check, by `computerMonotonicMs` (linux.ts, system-wide
   `process.hrtime`), so ages compare across the watchdog and host processes. Refuse rollback, a
   future sample time, and equal timestamps.
2. Watchdog identity (pid, start ticks, group) re-read at the check and equal to the pinned
   identity and the sample.
3. Sample run ID equals the pinned run ID. Sample generation equals the generation after the bump
   (line 68). The sample is taken after the bump.
4. A stop marker, latched stop, or stale generation refuses.
5. A fresh host-side inventory check, never the sample's word, runs after the removal step and
   inside the launch guard that `docker.create` calls (operations.ts:32-35). Before the desktop
   create it requires no resources. Before the gateway create (after the desktop start, line 105)
   it requires only this generation's desktop. Age is re-checked at both points.
6. A sample is single use. Consuming it records its hash, and a second admission with the same
   sample refuses.
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
