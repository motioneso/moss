# CI and production feedback speedup — implementation

## Task

Shorten the time between a change being finished, merged, and usable in production without weakening the safety net. The current CI run on PR #2059 demonstrates the problem: two compose smoke jobs complete in about five minutes each while the serial `Verify foundation and app` job takes 30+ minutes before merge can proceed.

## Scope and guardrails

- Start from `origin/main`; read `AGENTS.md` and `CLAUDE.md` in full.
- Inspect `.github/workflows/ci.yml`, deployment/release workflows, and `package.json` scripts before editing. Trace the merge-to-production path.
- Preserve full verification on `main` (or an equally protected post-merge/release path). Do not make production deploys depend on an unverified branch.
- Reduce redundant PR waiting: duplicate dependency installs, overlapping compose smoke jobs, and unnecessary serial ordering are candidates. Keep checks that catch materially different failures.
- Prefer workflow-level parallelism and reusable setup over adding new tooling. Avoid broad test deletions or speculative package abstractions.
- Add/update a small workflow test or validation where the repository has an existing pattern; otherwise validate YAML and explain the coverage tradeoff in the PR.
- Do not touch unrelated working trees, reset/stash shared work, or merge the PR yourself.

## Start

1. Map the current PR, push-to-main, and deployment workflows and list each check’s purpose, duration, and dependencies.
2. Design the smallest safe split between fast PR feedback, post-merge full verification, and deployment readiness.
3. Implement it in the workflow files/scripts you own, keeping required `main` coverage explicit.
4. Validate YAML/workflow syntax and run any available local checks. Report expected critical-path timing before/after and any remaining bottleneck.
5. Commit only your changes, push a branch, and open a PR against `main`. Do not merge; report the PR URL and exact safety invariants preserved.
