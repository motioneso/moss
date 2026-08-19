# Relay — #1327 Tasks 6-7 briefing action-row UI

**Spec:** `docs/superpowers/specs/2026-07-29-1327-briefing-action-rows.md` (§1, §8, §9 Tasks 6-7,
§10-12 are the sections in scope — do not read the rest).
**Issue:** #1327. **Risk tier:** `security`.
**Worktree/branch:** this worktree, `build/1327-action-row-ui` (based on `origin/main` @ `f810e45f`).
**Coordinator:** label `Coordinator`, session id `019fb9d9-8e73-7422-b7ff-67a7a5de94ec` — re-resolve
pane fresh via `herdr pane list`, never reuse a `…-N` number.
**Original handoff:** `docs/superpowers/handoffs/2026-07-31-build-1327-action-row-ui.md`.

## State

- Tasks 1-5 already shipped on this branch (#1372/#1374/#1376) — contracts, structured payload
  wiring, full morning/evening prose. Verified against the branch, not assumed from the spec.
- Plan for Tasks 6-7 written and committed: `docs/superpowers/plans/2026-07-31-1327-action-row-ui.md`
  (commit `430afb91`). Follows `plan-build` format (seams check, determinism boundary, exact
  contracts, test cases, unpiped verification commands, kill gate, rulings ledger).
- **Coordinator APPROVED the plan** (mid-relay, this session). Binding conditions from the
  approval: (a) Task 6 unit tests + phase-gate kill gate before Task 7 starts; (b) Task 7 must
  include the real dev-instance live-path artifact on the PR — e2e passing alone is not enough;
  (c) no feature code until the relay successor is verified driving (this doc's own rule, restated
  by the coordinator).
- **Zero feature code written.** Working tree is clean other than this handoff + the plan commit.
  The successor writes the FIRST feature code on this build.

## Next step for successor

1. `[ -d node_modules ] || pnpm install` (should already exist — skip if present).
2. Plan is approved — proceed straight to build. No need to re-message the coordinator for
   approval; do send a short "starting Task 6 build" note once you're driving, per
   `coordinated-build`'s escalate-on-blocker norm (not a gate, just visibility).
3. Build Task 6 test-first per the plan (new `briefing-action-rows.tsx`, one export added to
   `evening-mode.tsx`, single call-site swap in `today-page.tsx`, delete
   `today-suggested-email.tsx`), commit per task, run the plan's Task 6 phase-gate commands. **Kill
   gate: stop and message the coordinator after Task 6 is green, before starting Task 7** — this is
   a binding condition of the approval, not optional.
4. Task 7: e2e spec + the real dev-instance live-path artifact (assertions/evidence posted via
   `gh pr comment`) — the coordinator explicitly required the live artifact, not e2e-passing alone.
   If genuinely blocked (no live instance/credentials), report **code-complete, unverified**
   plainly; do not simulate or waive it.
5. Then `coordinated-wrap-up`. Follow `coordinated-build` throughout. Relay again on the next 70%
   meter warning — a countable trigger, not a felt threshold.

## Do not

- Do not re-read the full spec or handoff docs beyond what's cited above.
- Do not touch `client.ts`/`query-keys.ts` — the plan's seams check found no gap there.
- Do not merge, close the issue, or move the board — coordinator-only.
