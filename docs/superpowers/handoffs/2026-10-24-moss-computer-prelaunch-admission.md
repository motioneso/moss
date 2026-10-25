# Computer prelaunch admission: plan under review

Branch `feat/moss-computer-closure-reconcile`, PR 3684. Nothing is merged.

## Done

- Read the reconcile and publication handoffs and issues #3616, #3617 and #3618.
- Chose one slice: the check that must pass before any launch (watchdog alive plus a first
  healthy sample).
- Wrote the [plan](../plans/2026-10-24-moss-computer-prelaunch-admission.md). It shows that
  today's health sample needs the running pair (`scripts/computer-watchdog/observe.ts:65-71,114-132`),
  so it cannot gate the launch at `scripts/computer-host/operations.ts:75`. It recommends a
  two-phase watchdog and accepts only the host-only half.

## State at merge

- Plan merged via PR 3684. Plan bytes accepted by fresh Opus 5.5 Security and Standards/Spec
  reviewers at head 8f7375499 after four fix rounds. No code exists. `unavailableAdmission` is unchanged.
- Optional wording nit from the last review: the plan's lead-in "each with a removed-protection
  test" should read "each testable rule" (rule 2 is unsatisfiable and rule 8 untestable until the
  handover contract exists).

## Open items for the handover contract

- A trusted source for the watchdog identity (trust.ts pins none).
- How admission obtains a fresh sample after the generation bump, and how it reaches the launch guard.
- Where the consumed-sample record lives (the host state file accepts exactly three keys).
- Trusted boot ID on the sample.

## Next

1. Write and review the handover contract (watchdog phase one to bound phase two, gap under 10s).
   It must settle the open items above and is the real blocker for any launch.
2. Only then build the host-only prelaunch sample, with a removed-protection test per testable rule.
3. Parents #3577, #3616, #3617, #3618 and #3619 stay open.

Local scratch (may vanish): `/tmp/computer-reconcile-state.md`.
