# Build Handoff — Workshop 4: the Workshop page

**Spec (approved):** docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md
**Mockups:** docs/superpowers/specs/assets/2026-08-19-moss-workshop/ (workshop.html, chat.html,
plan.html, draft.html — approval.html is superseded, never build it)
**Plan (already written and coordinator-approved — do NOT re-plan from scratch):**
docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md — read only **"Group D — #1755"**
(starts at its own heading; stop before "Group E").
**GitHub issue:** #1755
**Risk tier:** routine
**Worktree:** ~/Jarv1s/.claude/worktrees/1755-workshop-page **Branch:** 1755-workshop-page (off
origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows exactly one pane with this label before messaging, resolved fresh (never a cached pane
number).
**Coordinator session id:** `01d11bc2-ed28-440a-9f95-3bf53f0046c7`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context ->
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. **Before any UI or CSS work, use the `design-system` skill** — jds-* primitives only, no
   invented classes; run the audit before calling this done.
3. Read the plan's "Group D" section only. Build the page shell against the mockups now; the
   plan's own notes say the data-wiring parts (draft status groupings) come from #1753, which is
   still building in parallel — wire that up once #1753's PR is visible, or stub it clearly if it
   isn't ready when you reach that step. Say which you did in your PR.
4. Skip straight to TDD build (plan is already coordinator-approved), then `coordinated-wrap-up`.

## Exit criteria for this lane

- Full gate green on an isolated gate DB.
- Design-system audit clean (no invented classes).
- **Live-path proof required** — this is a real UI surface. Post a `gh pr comment` with the
  feature exercised on a live dev instance (screenshot/DOM evidence), not just component tests.
- PR open, rebased on origin/main, referencing #1755.

## Run-specific bans (non-negotiable)

- Work only in this worktree/branch; `git add` by explicit path only.
- Never touch docs/coordination/, the project board, or merge anything.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- #1756 (chat cards) is building in parallel in a separate worktree — different surface, but both
  touch the Workshop feature area; if you find yourselves needing the same new shared component,
  flag it to the coordinator rather than each defining your own.
- #1752 (backend holder) is building in parallel; #1753/#1754 (data + build agent) are queued
  behind it. Your page shell does not need to wait for any of them to start.
