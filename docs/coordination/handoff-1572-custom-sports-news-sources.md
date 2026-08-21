# Build Handoff — 1572-custom-sports-news-sources

**Spec (approved):** docs/superpowers/specs/2026-08-17-1572-custom-sports-news-sources.md
**GitHub issue:** #1572
**Risk tier:** sensitive (new database table, migration chain)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1572-custom-sports-news-sources **Branch:** 1572-custom-sports-news-sources
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows EXACTLY ONE live agent
with this name, resolved fresh each time. The visible pane label should also be `Coordinator`.
**Coordinator session id:** 9674b6c7-87b1-4612-afad-361c7f9070fa (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Spec Exit Criteria met: users can add a public news source URL in Sports settings, Moss safely
  discovers and validates it, and failures are explained with a clear next step rather than
  silently disappearing.
- Full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- **Live-path proof required** — this is a user-facing settings feature. Post a `gh pr comment`
  showing it exercised through the real UI on the live dev instance, with the UAT run, exit code,
  and assertions or bounded evidence.
- Because this is `sensitive` tier: walk the invariant checklist explicitly in your PR description
  (DataContextDb/VaultContext usage if any file storage is touched, metadata-only job payloads if
  this queues any background work, module isolation).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- **Never assume a migration number.** #1524 already landed migrations 0185 and 0186 in the
  Sports area. Your migration must sequence after 0186 — check `infra/postgres/migrations/` for
  the current highest number immediately before writing yours, and confirm with the coordinator
  before merging if another Sports migration has landed in the meantime.

## Collision notes (from the coordinator)

- You share the Sports settings/migration area with #1524 (already merged, migrations 0185/0186)
  and #906 (still blocked behind you — do not coordinate with it, it hasn't started). Check for
  any newly-landed Sports migration before you write yours; do not hardcode a migration number
  from this doc.
