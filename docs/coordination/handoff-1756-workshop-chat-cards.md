# Build Handoff — Workshop 5: agreeing the plan, and changing a running draft, in chat

**Spec (approved):** docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md
**Mockups:** docs/superpowers/specs/assets/2026-08-19-moss-workshop/ (workshop.html, chat.html,
plan.html, draft.html — approval.html is superseded, never build it)
**Plan (already written and coordinator-approved — do NOT re-plan from scratch):**
docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md — read only **"Group E — #1756"**
(starts at its own heading, runs to the end of the file).
**GitHub issue:** #1756
**Risk tier:** routine
**Worktree:** ~/Jarv1s/.claude/worktrees/1756-workshop-chat-cards **Branch:**
1756-workshop-chat-cards (off origin/main)
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
3. Read the plan's "Group E" section only. Build the plan-approval and draft-change chat card
   shells against the mockups now. The plan's own notes say the plan-approval card needs #1754's
   plan-writing step to have real data to show — #1754 is queued behind #1752 and hasn't started
   yet, so build the card shell against representative fixture data and wire it to the real
   endpoint once #1754's PR is visible. Say which you did in your PR.
4. Skip straight to TDD build (plan is already coordinator-approved), then `coordinated-wrap-up`.

## Exit criteria for this lane

- Full gate green on an isolated gate DB.
- Design-system audit clean (no invented classes).
- **Live-path proof required** — this is a real UI surface (chat cards). Post a `gh pr comment`
  with the feature exercised on a live dev instance, not just component tests.
- PR open, rebased on origin/main, referencing #1756.

## Run-specific bans (non-negotiable)

- Work only in this worktree/branch; `git add` by explicit path only.
- Never touch docs/coordination/, the project board, or merge anything.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- #1755 (Workshop page) is building in parallel in a separate worktree — different surface, but
  both touch the Workshop feature area; if you find yourselves needing the same new shared
  component, flag it to the coordinator rather than each defining your own.
- #1754 (the build agent, plan-writing step) is queued behind #1752 and will land later — do not
  block on it, stub as described above.
