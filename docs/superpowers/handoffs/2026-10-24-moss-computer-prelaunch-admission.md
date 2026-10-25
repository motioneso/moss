# Computer prelaunch admission: parked before review

Branch `feat/moss-computer-closure-reconcile`. Parked for a machine restart. Nothing is merged.

## Done

- Read the reconcile and publication handoffs and issues #3616, #3617 and #3618.
- Chose one slice: the check that must pass before any launch (watchdog alive plus a first
  healthy sample).
- Wrote the [plan](../plans/2026-10-24-moss-computer-prelaunch-admission.md). It shows that
  today's health sample needs the running pair (`scripts/computer-watchdog/observe.ts:57-60,121-126`),
  so it cannot gate the launch at `scripts/computer-host/operations.ts:86-93`. It recommends a
  two-phase watchdog and accepts only the host-only half.

## Mid-flight

- The plan is unreviewed. No independent Security or Standards/Spec review has run.
- No code, no PR, no CI. `unavailableAdmission` is unchanged. No servers or browsers were started.

## Next

1. Open a docs PR with the plan and this handoff (fill in the Release note section as `Category: N/A`).
2. Get a fresh Opus 5.5 reviewer, who did not write the plan, for Security and Standards/Spec.
   Give it the plan and the three cited source ranges, not a conclusion.
3. Fix findings, then merge with `gh pr merge --squash --auto` once CI is green.
4. Only after acceptance, build the host-only prelaunch sample with a removed-protection test per
   admission rule.

Local state note: `/tmp/computer-reconcile-state.md` (may be lost on restart).
