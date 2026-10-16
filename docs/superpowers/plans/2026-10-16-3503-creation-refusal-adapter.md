# #3503 creation-only adapter implementation plan

Implement only the approved companion specification `docs/superpowers/specs/2026-10-16-3503-creation-refusal-adapter.md`.
Scope is two documentation files and the three code files explicitly leased below. No product behavior or general harness refactor.

1. Record Ben's agreement to the exact public behavior contract and local-only authoring grant, separately from coordinator plan approval.
   Require both, then publish only the exact approved task issue text. Record its assigned number in the implementation handoff.
   Before any commit use the repository shared-checkout procedure; confirm ownership and exclude every other agent's edits.
   Sanitize the two canonical docs, write their approved text, and commit both locally before touching code. No push or PR is authorized.
   This phase needs the owner's explicit local-only exception to usual docs PR/publication and finish-by-pushing requirements.
2. Keep the assigned worktree; do not checkout/reset/stash. Record current authoring base and compare fixed product candidate 70562d7df460737497124bf83c27849025ef372c.
   Review feasibility of a hard total-one-generation cap before coding; the Main chat fallback is an unresolved risk.
   If cap/evidence/cleanup enforcement requires product edits, another file, provider changes or broader setup, stop and propose a smaller slice.
3. In `tests/uat/provisioner.ts`, add only the opt-in injectable failure-evidence hook needed by this runner.
   Preserve the default collector for existing callers; make this runner's safe collector cover provisioning failures as well as case failures.
   Do not weaken cleanup or silently swallow evidence/cleanup errors into success.
4. Add `tests/uat/run-3503-creation-refusal.ts` with safe import/entry boundaries, explicit authority/readiness checks, one-attempt limits and cleanup.
   Use existing no-op auth injection, disable image building, and reject missing exact artifact/provider binding before runtime effects.
   Invoke only the new case; do not use generic failure capture or the full existing scheduled-source helper.
   Provide `--self-check` that runs only embedded deterministic fake-dependency assertions, with no provisioner/browser import effects or external commands.
   Cover verdict precedence; refusal correlation; filter rejection of private/extra fields; budget exhaustion; second-call denial; cleanup error precedence.
   These checks cannot establish that an installed public path actually enforces the cap; keep that technical hold explicit.
5. Add `tests/uat/specs/3503-tasks-creation-refusal.uat.spec.ts` implementing only the public case and safe assertions in the approved spec.
   Guard it against accidental execution by generic spec discovery without the dedicated runner's exact readiness/authority context.
   Do not install/login/configure a provider, seed by direct private-table writes, issue another chat request, or await report execution.
6. Run the bounded local checks below once. Fix relevant failures within the lease; two identical failures mean stop/rethink, never retry-loop.
   Existing dependencies only; no install, service, browser, network, Docker or database. Missing tools are reported as blocked, not installed.
   Each command has a 120-second outer deadline and raw exit status retained; do not pipe to conceal failure.

```bash
timeout 120s pnpm exec eslint tests/uat/run-3503-creation-refusal.ts tests/uat/specs/3503-tasks-creation-refusal.uat.spec.ts tests/uat/provisioner.ts --max-warnings=0
timeout 120s pnpm exec prettier --check docs/superpowers/specs/2026-10-16-3503-creation-refusal-adapter.md docs/superpowers/plans/2026-10-16-3503-creation-refusal-adapter.md tests/uat/run-3503-creation-refusal.ts tests/uat/specs/3503-tasks-creation-refusal.uat.spec.ts tests/uat/provisioner.ts
timeout 120s pnpm exec tsc --noEmit --incremental false -p tsconfig.json
timeout 120s pnpm exec tsx tests/uat/run-3503-creation-refusal.ts --self-check
```

7. For each claimed local filter/cap guard, temporarily disable it in the leased file, run the same offline self-check and require failure.
   Restore it immediately and recheck once. Record guard-on/guard-off exits; no product mutation, external effects or false public-path claims.
   Static review must enumerate success, refusal, preflight failure, provisioning failure, timeout, interruption and teardown paths.
   Trace each to the evidence collector and owned-resource cleanup; unresolved paths remain readiness blockers.
8. Coordinator assigns independent review of the exact frozen diff and offline evidence, with spec/lease/privacy/default-behavior checks.
   Reviewer approval is not Ben's agreement or runtime authorization. Fix blocking findings within scope and refreeze for review.
   Follow shared-checkout commit procedure for only owned code files; keep docs-before-code commit order and record exact commit hashes.
   Finish with owned files locally committed, unrelated files preserved, no push/PR/merge, no running resources and runtime NOT_RUN.
   Technical holds and any infeasibility must be candidly recorded; stop/reslice instead of expanding scope or claiming completion.

Never run verify:foundation, DB tests, integration/UAT runners or provisioning in this local phase.
Any later DB-touching verification requires verify-gate and its run-gate wrapper plus a separate exact owner grant.
Later setup and experiment grants must separately name source/artifact/provider binding and enforced limits; they are not included here.
