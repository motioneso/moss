# Build Handoff — #1121 scriptable UAT chat

**Spec (approved):** `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md`
**GitHub issue:** #1121
**Risk tier:** `sensitive`
**Worktree:** `~/Jarv1s/.claude/worktrees/1121-scriptable-uat-chat`
**Branch:** `build/1121-scriptable-chat` off `origin/main` at `7aa85f628`
**Build skill:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator:** label `Coordinator`, session `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1`

## Start

1. Run `[ -d node_modules ] || pnpm install`.
2. Read the approved spec by section for the current task only.
3. Invoke `coordinated-build`: verify the spec, create the `plan-build` plan, and send its pointer
   to the sole Coordinator for approval before writing code.
4. Finish through `coordinated-wrap-up`, including the spec's real UAT path and exact evidence.

## Run-specific bans

- Work only in this worktree; use explicit `git add` paths.
- Never touch `docs/coordination/` or run repo-wide formatting.
- Never expose credentials or private content in fixtures, logs, docs, or prompts.

## Collision notes

- #1121 is independent of #1557 and supplies no #1557 gate evidence. Scripted runs must pin the
  persistent runtime off exactly as the approved spec requires.
- #1533 is concurrently changing chat UI/UAT surfaces. Rebase after it lands if needed; do not
  absorb its feature scope or reuse its live-path proof.
- Preserve metadata-only job payloads, provider-agnostic AI, and normal data-context boundaries.
