# CI and production feedback speedup — independent review

## Task

Independently review how to shorten the gap between finished work and production usability in Jarv1s. Focus on whether CI is overkill, what is genuinely redundant, and what must remain before merge or deployment.

## Scope and guardrails

- Start from `origin/main`; read `AGENTS.md` and `CLAUDE.md` in full.
- Inspect `.github/workflows/ci.yml`, deployment/release workflows, and `package.json` scripts. Use bounded reads and identify actual job dependencies and duplicate setup/build/migration work.
- This is an independent review: do not edit the implementation agent’s files or any shared worktree. Write findings to `docs/superpowers/reviews/2026-08-28-ci-speedup-review.md` in your own worktree.
- Classify recommendations as safe now, needs follow-up, or unsafe. Preserve full post-merge/release verification and production safety.
- Do not merge or push unrelated work.

## Start

1. Measure/estimate the current critical path from PR creation through merge and production deployment.
2. Compare the implementation agent’s likely options against the workflow and deployment constraints, including failure visibility and rollback implications.
3. Produce a concise review with concrete file/line references, recommended minimal changes, and checks that must not be dropped.
4. Commit the review doc on your branch and report its path and findings. Do not open or merge a production-affecting PR unless explicitly asked later.
