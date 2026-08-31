# Fable handoff: plans for #1784, #1860, and #1869

## Objective

Write implementation plans for three Ben-approved specs. This is the `/start` **plan stage only**.
Do not implement code, open pull requests, close issues, or change project-board status. Stop after
the plans are written, reviewed against `plan-build`, committed, and pushed on this branch.

## Approved inputs

- Issue #1784, task part of #1252:
  `docs/superpowers/specs/2026-08-30-1784-chat-outcome-chip.md`
- Issue #1860, task part of #1738:
  `docs/superpowers/specs/2026-08-30-1860-module-build-env-isolation.md`
- Issue #1869, task part of #926:
  `docs/superpowers/specs/2026-08-30-1869-date-time-context.md`

Ben approved all three on 2026-08-30. For #1860, the approved choice is **parity scope**:
`PATH` and `JARVIS_CLI_TOOLS_PREFIX` are trusted operator deployment configuration. Do not widen
#1860 into executable integrity independent of those values, and do not overclaim its protection.

## Required process

1. Read `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, and `.claude/skills/plan-build/SKILL.md` in
   full. `plan-build` overrides generic writing-plan skills.
2. Read all three approved specs and GitHub issues in full.
3. Run the required agentmemory recall for `jarv1s current project state`, plus focused recalls for
   chat gateway/UI, CLI environment isolation, integration tests, timezone/Food, and prompt-cache
   discipline.
4. Use codebase-memory graph tools first. Perform the `plan-build` seams check against current
   `origin/main`; cite every assumed capability with current `file:line` evidence.
5. Write exactly these three plans:
   - `docs/superpowers/plans/2026-08-30-1784-chat-outcome-chip.md`
   - `docs/superpowers/plans/2026-08-30-1860-module-build-env-isolation.md`
   - `docs/superpowers/plans/2026-08-30-1869-date-time-context.md`
6. Each build slice must fit one agent session. Keep decisions, exact paths, signatures, behavioral
   tests, ordering, kill gates, and unpiped verification commands with expected exit codes. Include
   no implementation function bodies.
7. Apply the determinism boundary wherever relevant. #1784 and #1869 are user-facing and require a
   real live-path/e2e exit criterion; #1860 is internal security hardening with `Category: N/A` and
   requires adversarial security review.
8. Check each plan against every item in the `plan-build` review checklist. Run `git diff --check`.
9. Commit only the three plan paths explicitly with a documentation-only commit, push
   `plans/fable-next-ready`, and report the commit plus any unresolved blockers. Do not proceed to
   implementation even if no blockers remain.

## Guardrails

- You are not alone in the repository. Stay in this worktree and branch. Do not revert other work,
  switch branches, stash, reset, or use broad Git adds.
- Use `~/Jarv1s` rather than absolute local paths in documentation.
- GitHub and the board are already correct: all three issues are open, labeled `task`, linked to
  their parents, and In Progress. Do not mutate them.
- Prefer existing helpers and seams; propose no new abstraction or dependency unless current code
  proves it necessary.

## Start

Install dependencies for this fresh worktree, then execute the Required process above. Begin with
the seams check, not prose drafting.
