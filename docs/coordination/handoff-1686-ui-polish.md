# Build Handoff — 1686-ui-polish

**Spec (approved):** docs/superpowers/specs/2026-08-18-1686-ui-polish.md
**GitHub issue:** #1686
**Risk tier:** `routine` — pure CSS/copy tweaks across 5 isolated files, no shared-table, no
auth/RLS/migration/module-distribution surface. Standard QA, auto-merge after green.
**Live-path gate:** APPLIES — this is user-facing UI (sidebar, Today, Notifications, Settings,
buttons). Do not merge or close #1686 on CI-green alone. `coordinated-wrap-up` must post a
`gh pr comment` with live UI proof (each touched screen exercised on a live dev instance —
screenshot or bounded DOM check per changed element) before this lane is merge-ready. If you
cannot produce it, report **code-complete, unverified**, not "done".
**Worktree:** ~/Jarv1s/.claude/worktrees/1686-ui-polish **Branch:** 1686-ui-polish (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `1f677d74-7a87-4ee3-a5a4-8066500aefc4` (immutable authority; label is
only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. **Before any UI/CSS work, invoke the `design-system` skill** (per repo CLAUDE.md) — it defines
   the `jds-*` primitives, `tokens.css` typography rules, and the audit that catches invented
   classes. The spec's 6 tasks already reference real existing classes/tokens
   (`--rail-fg-muted`, `.cmd-empty`, `.tk-list`, `--space-4`, `--shadow-sm`) — do not invent new
   ones; if a step seems to need a class/token that doesn't exist, stop and re-check the skill
   before improvising.
3. Read the spec above by section for your current task only — it is short (6 small tasks, no
   task needs more than the file+lines it names). Reading is not progress: BUILD and commit per
   task.
4. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval
   (do NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). Escalation rules and gate commands are defined there — this doc does not restate them.

## Exit criteria for this lane

- Spec Exit Criteria met (all 6 tasks applied as specified; task 3 is an intentional no-op — do
  not touch the Tasks empty-state icon), full gate green on an isolated gate DB
  (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted** (see Live-path gate above) — required, this lane is user-facing UI.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No known collisions with the other active lane (`fix1659-defect4-r2`, test-harness only,
  disjoint files). If you touch anything outside the 5 files named in the spec, stop and escalate.
