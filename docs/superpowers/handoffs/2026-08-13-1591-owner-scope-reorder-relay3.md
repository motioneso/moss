# Relay 3 — 1591-owner-scope-reorder

**Issue:** #1591. **Risk tier:** security. **Worktree/branch:** this worktree,
`1591-owner-scope-reorder`. **Coordinator label:** `Coordinator` (resolve fresh via
`herdr pane list` — session id `caef4e32-df22-4310-a42d-866771a0ba6c`, do not trust a baked pane
number). Already messaged with this leg's status.

## Plan approval

Fable APPROVED (see relay2 doc, same dir). One non-blocking note already folded into Task 1's
commit message: confirming an already-resolved row now 404s not_found instead of 409 expired
(near-unreachable via UI). **State this as a known behavioral delta in the PR body.**

## Done (commits, in order)

- `42b9bd053` — Task 1+2: `resolveActionRequest` owner-scope reorder + unit test.
- `78775299f` — Task 3: `tests/integration/ai-assistant-action-resolve.test.ts` — fixed stale
  comment, added "both routes now 404 an unknown action id with status=confirmed too (#1591)".
  Verified passing standalone (isolated gate DB, `pnpm test:integration
  tests/integration/ai-assistant-action-resolve.test.ts` → 5/5 pass).
- `885883191` — prettier --write fix for 2 pre-existing format:check failures (unit test doc +
  plan doc) unrelated to this branch's logic, needed to get format:check green.

## Not done — pick up from here

1. **Task 4 — gate.** Ran `verify:foundation` in an isolated gate DB (`jarvis_gate_1591t3`) **4
   times tonight**. This branch's own tests (root `tsc --noEmit`, full `test:unit`, and
   `ai-assistant-action-resolve.test.ts` specifically) passed green **every single run**, isolation
   or full. But the full run failed 4/4 times on files **unrelated to this diff**, a different one
   each time:
   - Run 1: `tests/unit/chat-drawer-surface.test.tsx` (#1533, React `act()` warning) — confirmed
     flaky, passes standalone.
   - Run 2 & 3: `tuple concurrently updated` Postgres errors on `tests/integration/notes.test.ts`,
     `source-context-briefing.test.ts`, `email-action-suppression-rls.test.ts` — all pass
     standalone. Classic multi-agent-pg-contention (many lanes were "working" concurrently — check
     `herdr pane list` before your next attempt and prefer a quieter window).
   - Run 4: same `chat-drawer-surface.test.tsx` failure again.
   None of these 5 files are touched by this branch's diff (`git diff origin/main...HEAD --stat`:
   only `gateway.ts`, `ai-assistant-action-resolve.test.ts`, `gateway-resolve-owner-scope.test.ts`,
   2 docs). **Next step:** re-run the gate recipe below once the box is quieter; if it still snags
   on an unrelated file, that's evidence of systemic contention, not a regression — note it in the
   PR body per verify-gate's own guidance rather than retry-looping indefinitely.
   ```bash
   GATEDB=jarvis_gate_1591t3
   docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
   docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
   export JARVIS_PGDATABASE=$GATEDB
   pnpm verify:foundation > /tmp/1591-gate.log 2>&1; echo "EXIT=$?"
   ```
2. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
3. `coordinated-wrap-up`: clean tree, gate green, push, open PR tagged `[SECURITY]`, rebased on
   `origin/main`. **PR body must state the known behavioral delta** (Plan approval section above).
   Report PR + evidence to the coordinator. **Do not merge, close, or touch the board** —
   security-tier, needs Ben's explicit merge sign-off tonight.

## Run-specific bans (unchanged)

- Work only in this worktree/branch; `git add`/`git commit` by explicit path only
  (shared-checkout skill). Worktree was single-occupant at last check — re-verify.
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets in any doc/payload/log/prompt.
- #1592 is queued behind this lane — coordinator won't spawn it until this PR lands on `main`. No
  action needed here beyond landing cleanly first.

## Relay trigger

Context-meter 70% warning, immediately after Task 3 + the gate contention investigation. Real
progress this leg: Task 3 built, tested, and committed; format fix committed; gate run 4x with
root cause isolated to shared-box contention (not this branch). Successor should read this doc in
full (short by design), then resume via `coordinated-build` at Task 4 (retry gate), then pre-push
trio + `coordinated-wrap-up`.
