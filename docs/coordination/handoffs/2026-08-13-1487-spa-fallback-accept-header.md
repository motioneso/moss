# Build Handoff — 1487-spa-fallback-accept-header

**GitHub issue:** #1487 — "SPA fallback 404s '/' for any request without an Accept: text/html
header." No separate spec doc; scoped fix, build off Fable's investigation below (already done —
do not re-investigate).
**Risk tier:** `routine` (Fable's ruling: single file + tests, not security) — standard QA,
auto-merge after green. Still touches a live-serving path, so a live-path proof is required (see
exit criteria).
**Fable's investigation (complete — this lane skips the draft-plan-and-wait-for-review step;
build directly from this):**

(a) No caller depends on the strict no-Accept 404. Sole Accept-dependent caller in the tree is
`apps/web/public/service-worker.js:9-12`, which explicitly sends `Accept: text/html` on its
`fetch('/')` — with a comment noting it does so BECAUSE of the fallback; that's a workaround, not
a dependent. Dev compose healthcheck hits `/health`, prod hits `/health/ready` — both excluded at
`static-web.ts:82` before the fallback runs. nginx (`jarv1s-web.conf`) routes `/api/` and
`/health*` separately. No unit test pins the no-Accept-404 behavior
(`tests/unit/api-static-web.test.ts` asserts 404 only for `/api/missing` WITH
`accept: text/html`, and for the `/%2e%2e/` traversal path which the dot-check catches). The
curl-404 memory documents agents MISREADING this behavior as a broken deploy, not depending on it.

(b) **Fix:** in `apps/api/src/static-web.ts`, serve the SPA when `!accept ||
accept.includes('text/html') || accept.includes('*/*')` — so bare curl and PWA/no-Accept clients
get the app, while explicit `Accept: application/json` still gets a clean 404.

**Scope:** `apps/api/src/static-web.ts` + `tests/unit/api-static-web.test.ts`.
**Worktree:** `.claude/worktrees/1487-spa-fallback-accept-header`
**Branch:** `1487-spa-fallback-accept-header` (off `origin/main` @ `198928da4`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Reviewer for questions only (not required for plan approval):** pane labelled
`spec-1248 (Fable)` / `spec-1248-fable`.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Build per `coordinated-build`, TDD, commit per step. Two new unit tests: no-Accept `GET /`
   returns 200 index (fails on today's main — that's the regression proof); `Accept:
   application/json` `GET /settings` returns 404.
3. Optional fast-follow (only if time allows, not required for exit): simplify the
   `service-worker.js:9-12` workaround comment now that the fallback no longer needs it.
4. Report done to the Coordinator per `coordinated-wrap-up`.

## Exit criteria

- The two tests above, both passing.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- Live-path proof: one bounded `curl` against live dev (no `Accept` header hitting `/`, and an
  `Accept: application/json` hit on a missing path), recorded as a `gh pr comment`.
- PR open, rebased on `origin/main`.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None identified against tonight's other lanes — distinct file from every other lane's scope.
- If the lane finds itself arguing for option (i) — dropping the `Accept` check entirely, which
  loses the clean-404 behavior for API-ish clients — STOP and route back to the Coordinator/Fable
  instead of building it; Fable's ruling only clears option (ii).
