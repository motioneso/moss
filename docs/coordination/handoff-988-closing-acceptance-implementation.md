# Handoff — #988 closing acceptance implementation

## Assignment

Execute approved Tasks 1–2 and acceptance Tasks 3–6 from
`docs/superpowers/plans/2026-07-16-988-closing-acceptance.md` for GitHub issue #988.

## Workspace and authority

- Worktree: `~/Jarv1s/.claude/worktrees/ux-988-closing-acceptance`
- Branch: `ux/988-closing-acceptance`
- Risk tier: `routine`
- Coordinator routing label: `UX Coordinator`
- Coordinator immutable Codex session: `019f6c76-593d-7fd2-b33d-78bd72045265`
- Approved spec: `docs/superpowers/specs/2026-07-16-988-closing-acceptance.md`
- Approved plan: `docs/superpowers/plans/2026-07-16-988-closing-acceptance.md`
- You own implementation, verification, evidence, and PR creation. You do not merge or move board
  state.

## Locked product decisions

- Today: remove only the proactive-card `critical` / `high` / `normal` / `low` priority-band pill.
  Keep priority ordering and stripe, Today task-row short dates, persisted-timezone rendering,
  source, title/details, drift state, and dismiss behavior.
- Appearance: built-in accent selection and light/dark mode are independent. Normalize legacy
  Dark to Forest + dark. Existing custom themes remain fixed-palette in this slice.

## Execution scope

- Read the approved plan one task section at a time; do not load the full plan at once.
- Implement Tasks 1–2 with the smallest existing-pattern diff and focused regression coverage.
- Execute Tasks 3–6 as written. Reuse existing UAT/Webwright provisioner and evidence contract;
  do not create another harness.
- A user-facing UI PR is code-complete but unproven until live desktop and narrow-path evidence is
  posted on the PR. Record the required run links and assertions/evidence before wrap-up.
- Keep GitHub #988 open and project state unchanged; the coordinator owns merge and bookkeeping.

## Collision and preservation guardrails

- Review lanes E/F/G are parked. Do not touch their branches, worktrees, panes, or artifacts.
- Preserve unrelated working-tree changes and generated evidence outside this lane.
- Do not edit `docs/coordination/2026-07-12-ux-hardening.md`; coordinator-only.
- Never use broad staging or repo-wide formatting. Stage explicit paths only.
- Do not touch primary `Coordinator` session `f3e5e852-b905-47f4-bbb0-df8f9b2d95f1`.
- Follow CLAUDE.md hard invariants and the authored design system. No new dependency or abstraction
  unless the approved plan explicitly requires it.

## Start

1. Run `pnpm install`.
2. Read this handoff in full, then invoke `coordinated-build`.
3. Read Task 1 only, inspect all callers of the shared path you will change, and send a compact
   plan pointer to `UX Coordinator` for approval under the standing delegated authority.
4. Build through Task 6, commit per coherent task, and invoke `coordinated-wrap-up` when complete.
5. Report PR number, exact head, verification exit codes, and live-path evidence pointer to
   `UX Coordinator`; then stop.
