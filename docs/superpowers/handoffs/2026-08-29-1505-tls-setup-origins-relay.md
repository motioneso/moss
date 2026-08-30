# 1505 TLS setup-origins — state

Branch 1505-tls-setup-origins, worktree clean, commit e9a7248c5 has all 4 owned files
(scripts/setup-prod-origins.ts, scripts/setup-prod.ts, tests/unit/setup-prod-trusted-origins.test.ts,
infra/env.production.example). Plan: docs/superpowers/plans/2026-08-29-1505-tls-setup-origins.md.

Done: all 6 tasks implemented. Target test file 46/46 pass. Neighbor tests 21/21 pass.
tsc --noEmit and tsc -p tsconfig.tests.json --noEmit both clean. eslint clean. prettier clean
on the 3 code/test files (prettier has no parser for infra/env.production.example — pre-existing
tooling gap, not a real issue).

Left: run pnpm verify:foundation via the verify-gate skill (never run it raw), pre-push rebase
onto origin/main, push, open PR with plan-derived release note (Category: N/A, no user-facing
surface), report status. No live-path proof needed — plan's Live-path gate section says this
lane has no user-facing surface; end-to-end HTTPS proof is child 4's job.
