# 1505 TLS setup-origins — relay 2 (post-QA fix)

Branch `1505-tls-setup-origins`, worktree `/home/ben/Jarv1s/.claude/worktrees/1505-tls-setup-origins`.
PR is open: https://github.com/motioneso/moss/pull/2078
Plan: docs/superpowers/plans/2026-08-29-1505-tls-setup-origins.md
Spec: docs/superpowers/specs/2026-08-10-self-hosted-tls.md (section "Child 2", around line 315)
Coordinator herdr agent name: `coordinator`. My own herdr name: `build-1505-tls`, pane w1:p1Y (re-resolve fresh, don't trust this number).

## What's done

Gate is green (226 files, 2182 tests passed, 2 skipped). Format/lint/typecheck green. PR #2078 open
and reported to the coordinator. A security reviewer then posted a verdict comment on the PR
(`gh api repos/motioneso/moss/issues/2078/comments`) with 2 blocking findings and 3 non-blocking notes.

## What's left — the blocking fix

**The problem:** turning TLS on with this PR does not make the login cookie secure, and the plain
HTTP port stays open at the same time. Someone on the same network could steal a login session even
after TLS is "on". The setup script correctly keeps the API's own internal base URL as
`http://localhost:3000` (that's deliberate, confirmed by the spec at line 186 — do not change that).
The real gap is that nothing in the code asks for a secure-only cookie once TLS is turned on.

**Where the fix goes:** `packages/auth/src/index.ts`, function `createBetterAuthOptions` (around
line 250-339). It builds the options object passed to `betterAuth(...)`. Right now `advanced` (line
322-326) only sets `database: { generateId: "uuid" }`. Better-auth has a documented
`advanced.useSecureCookies` boolean — set it `true` whenever the deployment is behind TLS.

**How to know TLS is on, from this function:** the codebase already has exactly this signal in
`apps/api/src/server.ts` lines 192-193 and 254-262 — `JARVIS_TRUST_PROXY` is read via
`resolveTrustProxy(resolveMossEnv(process.env, "JARVIS_TRUST_PROXY"))`, and `trustProxy !== false`
is the exact test already used there to decide whether to turn on the HSTS security header. Reuse
the same signal and the same reasoning for cookies: read `JARVIS_TRUST_PROXY` the same way inside
`createBetterAuthOptions` (it already receives `env: NodeJS.ProcessEnv`), call the same
`resolveTrustProxy` (exported from `apps/api/src/server.ts` — check whether `packages/auth` can
import it, or whether the trust-proxy-parsing logic needs to move somewhere both packages can reach;
do not duplicate the parsing rules by hand), and set
`advanced: { useSecureCookies: trustProxy !== false, database: { generateId: "uuid" } }`.

**Verify the option name before trusting this doc.** `node_modules` was unreadable in the review
sandbox and may be unreadable for you too — if so, use the context7 MCP tool
(`resolve-library-id` for "better-auth", then `query-docs` on `/better-auth/better-auth` asking about
`advanced.useSecureCookies`) to confirm the exact option shape and behavior before writing code.

**Test to add:** a case (in whichever test file already covers `packages/auth`'s options-building —
grep for `createBetterAuthOptions` or `advanced` in `packages/auth`'s own test directory) proving
that with `JARVIS_TRUST_PROXY` set, the resulting options have `useSecureCookies: true`, and with it
unset, `false`/absent. This directly answers the reviewer's "not-tested" gap: "No test proves a
TLS-enabled config produces a Secure / `__Secure-` session cookie."

**This PR stays open regardless.** Issue #1505 itself says: "Keep the PR open until Child 4
integration proof." So even after this fix, do not ask the coordinator to merge — just push the fix,
report back, and the PR waits for Child 4 (the real-device end-to-end proof) like it already
did. Say this plainly in your report so nobody mistakes a green fix for merge-ready.

## The three non-blocking notes — fix if practical, all cheap, all inside files already owned by this lane

1. **Host case.** `scripts/setup-prod-origins.ts`, `validateTlsHost`/`resolveTlsSettings` (roughly
   lines 39-127). An uppercase `JARVIS_TLS_HOST` (e.g. `Jarv1s.Example.com`) is accepted as-is and
   the derived trusted origin keeps the uppercase. Browsers send a lowercased host in the real
   request, so this could recreate the exact lockout this PR exists to prevent. Fix: lowercase the
   host right after validation, before building `httpsOrigin`. Add a test with an uppercase host
   proving the derived origin comes out lowercase.

2. **Proxy-address drift risk.** `scripts/setup-prod-origins.ts`'s `deriveCaddyProxyIp` computes the
   address from `JARVIS_DOCKER_SUBNET`; the sibling PR (#1504/#2077, `infra/docker-compose.prod.yml`)
   pins Caddy's actual address as a literal `10.251.0.254` with a comment asking operators to keep it
   in sync. They only agree for the default subnet — a non-default subnet would make setup write a
   trust address nothing owns. Cheapest fix within this lane's owned files: change test S1 in
   `tests/unit/setup-prod-trusted-origins.test.ts` (currently restates `10.251.0.254` as a literal)
   to instead read the pinned address out of `infra/docker-compose.prod.yml` (read-only — do not
   edit that file, it belongs to the other lane) and assert the two match. That turns a silent
   possible drift into a test failure the moment either side changes. A full fix (deriving one from
   the other, or refusing a non-default subnet while TLS is on) is a bigger design change — flag it
   to the coordinator rather than deciding it solo, but the test-reads-the-real-file fix is safe to
   just do.

3. **Env-var naming.** `scripts/setup-prod.ts` around lines 69-71: `JARVIS_TLS_HOST` and
   `JARVIS_TLS_ISSUER` are read straight off `process.env` while their neighbors go through
   `resolveMossEnv`'s `MOSS_*`/`JARVIS_*` fallback shim. This is deliberate, not a bug — Docker
   Compose host-side interpolation and the Caddyfile read these two names directly and cannot see a
   `MOSS_*` rename. The practical fix here is just a one-line comment at the read site explaining
   why, so the next reader (or reviewer) doesn't flag it again. Do not change these two to go through
   the shim.

## After the fixes

Run: `pnpm exec vitest run tests/unit/setup-prod-trusted-origins.test.ts` and whichever test file
covers `packages/auth` options, then the pre-push trio
(`pnpm format:check && pnpm lint && pnpm typecheck`), then the full gate via the `verify-gate` skill
(never run `pnpm verify:foundation` directly — it hits the live dev database if you do). Then
`git fetch origin main && git rebase origin/main`, push, and reply on the PR review thread (or a new
`gh pr comment`) citing the fix commit SHA and exact file:line for each finding — the coordinator
skill requires this ("every 'fixed' must be checkable in one look"). Then message the coordinator
(herdr name `coordinator`) with the same summary in plain English, and remind it the PR stays open
for Child 4 per #1505's own text.

## Standing rules (carry forward, plain English only in status/handoff text)

- Never pipe a gate command; only run the gate through the verify-gate skill.
- Waits are event-driven, never polled.
- Not done until pushed — but this PR does not merge yet regardless (Child 4 hold).
- This is relay 2. If the meter warns again before you've pushed a fix, stop and report to the
  coordinator for a re-slice rather than relaying a third time.
- Never touch docs/coordination/, never run a repo-wide format or broad git add.
- No jargon in status updates — name what a thing does, not what the repo calls it.
