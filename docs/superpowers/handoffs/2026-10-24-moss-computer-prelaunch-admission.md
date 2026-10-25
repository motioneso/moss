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

## Mid-flight

- PR 3684 is open. The first review found fixes (see Update), now applied. Re-review pending.
- No code. `unavailableAdmission` is unchanged. No servers or browsers were started.

## Next

1. Get fresh Opus 5.5 reviewers (Security, Standards/Spec) to re-review the revised plan.
2. Fix findings, then merge with `gh pr merge --squash --auto` once CI is green.
3. Only after acceptance, build the host-only prelaunch sample with a removed-protection test per
   admission rule.

Local state note: `/tmp/computer-reconcile-state.md` (may be lost on restart).

## Update

PR 3684 plan reviewed by two fresh Opus reviewers (security, standards): both accept with fixes. Fixes applied in the plan: corrected citations, stop-marker carry-over, generation binding, policy rejection of prelaunch samples, recheck before create, stated scope limit. A re-review of the revised plan is the next step.
