# Build Handoff — #1533 chat-surface routing

**Approved spec:** `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md`
**Approval:** Fable comment on PR #1563; sole binding edit landed in merge `abfe0478b`
**GitHub issue:** #1533
**Risk tier:** sensitive (runtime navigation/chat-surface contract)
**Worktree:** `~/Jarv1s/.claude/worktrees/1533-chat-surface-build`
**Branch:** `build/1533-chat-surface-routing` from current `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator`
**Coordinator session id:** `019fef6b-8f40-7453-a6f9-4c3e245dce52`

## Start

Read the approved spec by section for the current task, then follow coordinated-build. Read and
follow the design-system skill before UI edits. Plan first and wait for Coordinator approval.
Implement test-first, including Fable's required runtime call-argument assertions in the new
`tests/unit/chat-model-pill-surface.test.tsx`.

## Exit criteria

- Every approved spec criterion met without backend/package edits.
- Focused tests plus required repo gate evidence green.
- Sensitive-tier invariant check confirms no AccessContext/RLS/persistence/gateway-contract change.
- Live-path proof shows a module-tab action request renders without reload inside the bounded
  observation window.
- Draft PR opened and reported; do not merge.

## Collision notes

- #1557 pending code changes are under `packages/**`; this approved boundary is `apps/web/**`
  plus focused tests, so no current file collision.
- #1560 touches Today/evening files only and is independent.
- Never touch `docs/coordination/`, project fields, milestones, or merge state.
