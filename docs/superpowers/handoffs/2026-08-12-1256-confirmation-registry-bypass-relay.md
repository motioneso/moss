# Relay — #1256 confirmation registry bypass

**Branch/worktree:** `1256-confirmation-registry-bypass` (this worktree, unchanged — do not
`pnpm install`, `node_modules` already present).
**Coordinator label:** `Coordinator` (Herdr). Resolve pane fresh by label + session id — never a
baked `…-N`.
**Risk tier:** security → Opus adversarial QA required before merge (per handoff doc, which lives
only in the coordinator's worktree, uncommitted:
`.claude/worktrees/coord-overnight-20260810/docs/superpowers/handoffs/2026-08-12-1256-confirmation-registry-bypass.md`).
**Spec:** GitHub issue #1256 body IS the spec — no spec file on disk, confirmed intentional.

## State

- **Step ½ (verify spec against branch): done.** Bug confirmed still live at
  `packages/ai/src/routes.ts:533-553`. Fix pattern confirmed (late-bound adopt seam, same as
  `adoptChatRpcConnection`). All seam citations are in the plan file below.
- **Step 1 (plan): done and committed** — `97c5a7cb7`,
  `docs/superpowers/plans/2026-08-12-1256-confirmation-registry-bypass.md`. Read it in full (it's
  short) before doing anything else — it has the exact task breakdown, signatures, and two
  build-time decisions you must resolve (Task 4: adopt-callback vs return-value; lazy-fallback
  outcome vocab).
- **Escalation: sent, awaiting reply.** Messaged the `Coordinator` pane
  (`herdr agent prompt`) with the plan summary and relay notice. **Do not start Task 3+ (code)
  until you see the coordinator's approval or a fork instruction.** Check for a reply first —
  `herdr pane read <coordinator-pane> --source recent --lines 40` (resolve pane fresh by label).
  If no reply yet, it may still be processing (it showed `agent_status: done` / idle when
  messaged, so a reply should come soon) — do not re-send, just wait/check once more before
  proceeding.
- **No code has been written yet.** Zero files touched under `packages/`. This relay is plan +
  escalation only, per the context-meter 70% trigger (fired during step ½ research, before any
  code).

## Next steps (in order)

1. Check for coordinator approval (see above). If approved (or if a fork was flagged, follow the
   coordinator's routing instead), proceed to Task 1 of the plan.
2. Build Tasks 1–5 from the plan via `superpowers:test-driven-development` — one commit per task,
   `git add` by explicit path only (this is a shared-checkout tree in principle; verify with
   `git status`/`git diff` before each commit per the `shared-checkout` skill, even though this
   worktree currently appears lane-dedicated).
3. Resolve the two flagged build-time decisions as you hit Task 4 — don't leave them open, the
   plan says why each matters.
4. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main` before every push.
5. `coordinated-wrap-up`: gate (via `verify-gate` skill, isolated DB), push, open PR, report to
   coordinator. No UI surface — note "code-complete, no UAT needed (internal API contract fix)" in
   the PR unless you discover a UI caller. Security tier — flag for Opus QA in your report.

## Constraints (verbatim from original brief — do not relax)

- Work ONLY in this worktree/branch.
- `git add` only by explicit path, never `-A`/`.`.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Do not delete the resolve route — it's manifest-declared public API
  (`packages/ai/src/manifest.ts:350-356`, `permissionId: "ai.assistant-actions"`). Any schema
  change must be additive.

## Read only by section, not front-to-back

The plan file is short — read it whole once. Do NOT re-read the handoff doc, the issue, or any of
the source files already cited in the plan's "Seams check" section — those citations are verified
current as of `97c5a7cb7`; trust them and go straight to editing. Re-deriving them burns budget for
no new information.
