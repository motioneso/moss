# Build Handoff — 1555-capability-timeout

**Spec:** none — mechanically-tiered small fix, no new feature/module (already classified this way
in `docs/coordination/2026-08-10-overnight-run.md` → "Ready-after-current lanes": "bounded
model-discovery fetch + existing fallback is ready without Fable"). Build directly against the
issue.
**GitHub issue:** #1555 — read it in full first (`gh issue view 1555 --repo motioneso/moss
--comments`); the manifest's one-line gloss is not enough to build from.
**Risk tier:** `sensitive` (per manifest classification — confirm against the issue's actual
content once you've read it; escalate to the coordinator if it reads as `security` instead, e.g.
if it touches auth/secrets/network-exposed surface rather than pure model-discovery/fallback
behavior).
**Worktree:** `.claude/worktrees/1555-capability-timeout` **Branch:** `1555-capability-timeout`
off `origin/main`
**Build skill path (absolute):** `.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; resolve the pane fresh
each time (never a cached pane number).
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20` (immutable authority).
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read issue #1555 in full — that IS your spec for this lane. It concerns a bounded
   model-discovery fetch with an existing fallback path; confirm exact scope from the issue body,
   not from this handoff.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** (scope is small — plan should be
   short) → coordinator approval (do NOT write code before it) → TDD build →
   **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria

- Spec/issue exit criteria met, full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- Live-path proof posted if this touches a user-facing feature/UI surface — check the issue; if
  it's purely internal (model-discovery fetch/fallback logic with no UI change), note that
  explicitly in the PR instead of a UAT run, per `coordinated-wrap-up`'s live-path-gate section.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None known.
