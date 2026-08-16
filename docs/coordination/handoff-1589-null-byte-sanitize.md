# Build Handoff — 1589-job-failure-incident-closure (Phase 1b only)

**Spec (approved):** docs/superpowers/specs/2026-08-15-1589-job-failure-incident-closure.md
**GitHub issue:** #1589 (labels: bug, task)
**Risk tier:** `sensitive` (writes into `app.memory_chunks`, a shared table carrying private note
content — not `security`: no auth/RLS/secret/network-exposed surface involved)
**Worktree:** ~/Jarv1s/.claude/worktrees/fix-1589-null-byte-sanitize
**Branch:** fix-1589-null-byte-sanitize (off origin/main @ f31a840e9)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging, verify
`herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `91a78602-812a-461e-afa4-5498bb9000c5` (immutable authority; label is
only routing).
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context → message
the coordinator, then use the `relay` skill immediately.

## Scope — read carefully, this spec has THREE phases and you build ONLY ONE

The spec covers three phases. **Build Phase 1b only.**

- **Phase 1a (prod recovery confirmation) — OUT OF SCOPE, Ben-only.** Do not attempt it.
- **Phase 1b (THIS BUILD):** strip `U+0000` and the C0 control range (keep `\t`/`\n`/`\r`) at the
  repository boundary in `packages/memory/src/repository.ts` — the bind site is around line 74; the
  delete-then-insert data-loss path is around lines 66-69. Add the spec's stated behavioural tests.
  **Explicitly decide and state in your PR description** whether `sourcePath` needs the same
  sanitization as the content field, or whether content alone is the right boundary — don't
  silently sanitize both without reasoning about it.
- **Phase 2 (box-wide job-failure alerting) — OUT OF SCOPE, deferred.** The spec itself recommends
  splitting this to a new issue rather than bundling it. Do not build it. Note in your wrap-up
  report that Phase 2 still needs its own `task` issue filed (the coordinator will handle filing it
  at close-out, not blocking this PR).

Exit criterion 5 in the spec (about the future alerting decision) is bookkeeping only — do not
treat it as a build requirement.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec BY SECTION for Phase 1b only — never in full.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** → coordinator approval → TDD build →
   **`coordinated-wrap-up`** (PR + live-path proof if applicable + report).

## Exit criteria for this lane

- Phase 1b's behavioural tests pass, full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- This is a data-layer fix, not a new user-facing UI surface — live-path proof likely N/A; if in
  doubt, ask the coordinator rather than skip silently.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No file-level overlap with the parallel #895 lane (that lane touches only
  `.github/workflows/ci.yml` and doc files). No migration number assigned by either spec — you do
  not need to coordinate a migration number.
