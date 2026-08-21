# Build Handoff — Workshop 2: a draft module that runs for its author alone

**Spec (approved):** docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md
**Plan (already written and coordinator-approved — do NOT re-plan from scratch):** the plan is
committed on branch `plan/1739-stage1-workshop`, not on `main`, at path
`docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`. Read only **"Group B — #1753"**
(starts at that heading, stop before "Group C"). Since your worktree's branch is off `main`, that
file won't be checked out — read it directly from git's object store without checking out the
branch:
```
git show plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md | sed -n '550,1052p'
```
**GitHub issue:** #1753
**Risk tier:** routine
**Worktree:** ~/Jarv1s/.claude/worktrees/1753-draft-module-author-only **Branch:**
1753-draft-module-author-only (off origin/main, already includes #1752's merged holder API)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows exactly one pane with this label before messaging, resolved fresh (never a cached pane
number).
**Coordinator session id:** `7a4759d1-8ede-4252-b513-372e1d27694b`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context ->
message the coordinator, then use the `relay` skill immediately.

## Depends on (already landed)

#1752 merged to `main` (PR #1806) — the shared module discovery holder is available at its
current shape: `createExternalModuleDiscoveryHolder`, `getDiscoveries`, `rescan`. Do not rename
these without flagging it to the coordinator first — #1754 depends on the same names.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the plan's "Group B" section only (command above), not the whole plan or the spec in full.
3. Since the plan is already coordinator-approved, skip straight to TDD build following
   `coordinated-build`'s build step, then `coordinated-wrap-up` (PR + live-path proof if
   applicable + report). Check the plan's own task description for whether this has a UI surface;
   if genuinely none, note "no UI surface, live-path gate does not apply" in your PR instead of
   skipping silently.

## Exit criteria for this lane

- Full gate green on an isolated gate DB.
- PR open, rebased on origin/main, referencing #1753.
- Downstream note: #1754 in this same plan depends on your work landing — say so plainly in your
  PR description so the coordinator knows it's safe to unblock it.

## Run-specific bans (non-negotiable)

- Work only in this worktree/branch; `git add` by explicit path only.
- Never touch docs/coordination/, the project board, or merge anything.
- No secrets in any doc, payload, log, or prompt.
- Do not merge your own PR, even if CI goes green — the coordinator merges after independent QA.

## Collision notes

- #1754 (same plan, different worktree, spawns after you land) will build against your work's
  shape once your PR is up.
- #1755 and #1756 (front-end shell) are being built in parallel and do not depend on you.
