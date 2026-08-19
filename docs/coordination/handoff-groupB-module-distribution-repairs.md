# Build Handoff — post1632-groupB-module-distribution-repairs

**Spec (approved):** docs/superpowers/specs/2026-08-16-post1632-groupB-module-distribution-repairs.md
**GitHub issues:** #1057, #1042, #1223, #1222 — all four covered by this one spec/PR.
**Risk tier:** `sensitive` — module distribution/install/reconcile is a serialization/isolation
trigger. Standard QA plus an explicit invariant check plus matched e2e-UAT; per-merge digest to Ben.
**Worktree:** ~/Jarv1s/.claude/worktrees/groupB-module-distribution-repairs
**Branch:** groupB-module-distribution-repairs (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74` (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Serialization note from spec author (Fable) — now cleared

#1057 touches `scripts/module-reconcile.ts`, the same file #1468 was mid-fix on. This lane was
held until #1468's PR (#1647) merged. **Confirmed merged** (mergedAt 2026-08-17T02:01:46Z) —
`origin/main` already contains it, and this worktree was cut from `origin/main` after that merge,
so you are unblocked and do not need to re-check this yourself.

## Scope note from spec author (Fable)

#1222 and #1223 are two facets of the same distribution-repair problem and are meant to land as a
single PR, not split — don't spawn a second lane or open a second PR for one of them.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval (do
   NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). Escalation rules and gate commands are defined there — this doc does not restate them.

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB** (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface — #1042
  explicitly does (module distribution UI/CLI runner surface per Fable's spec notes), so plan for
  a real install/reconcile pass on a live dev instance, not just unit coverage.
  Cannot produce it? Report **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.
- Sensitive tier: explicitly verify and state in your wrap-up report which invariant(s) apply here
  — likely module isolation (no reaching into another module's internals/tables) and metadata-only
  job payloads if this touches pg-boss at all.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Never edit an applied migration — add a new file if a schema change is needed.

## Collision notes (from the coordinator)

- No known file overlap with the concurrently-running Group A / Group C lanes or #1522 (Fable
  confirmed zero overlap when drafting these three specs). The one real collision (#1057 vs
  #1468) is cleared per above. If you discover further overlap, stop and escalate rather than
  guessing at merge order.
