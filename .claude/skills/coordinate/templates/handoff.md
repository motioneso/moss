# Build Handoff — <spec slug>

**Spec (approved):** docs/superpowers/specs/<slug>.md
**GitHub issue:** #NN — **required, no exceptions.** Never `—`, never "live feedback". A lane with
no issue is invisible to every later sweep; that is how nine live-verified commits were deleted on
2026-07-26. If this field is empty, escalate before planning.
**Risk tier:** `routine` | `sensitive` | `security` (see `coordinate` Risk tiering. `security` ⇒
this PR gets adversarial Opus QA + Ben merge sign-off — build to that bar.)
**Worktree:** <repo>/.claude/worktrees/<slug> **Branch:** <branch off origin/main>
**Build skill path (absolute):** <repo>/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows EXACTLY ONE live agent
with this name, resolved fresh each time. The visible pane label should also be `Coordinator`.
**Coordinator session id:** `<agent_session.value>` (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately. **Relay budget: ONE.** Your slice
was scoped to fit one session (Ben, 2026-08-23). If you are already a `-relay1` successor and hit
the trigger again with no PR open, do NOT relay — push what you have, write the state doc, and
report to the coordinator for a re-slice into smaller lanes.
**If the coordinator name resolves to 0 agents:** that's usually a coordinator relay in progress —
arm a background retry (`until herdr agent list | grep -q '"coordinator"'; do sleep 120; done`,
~15 min budget) and keep working on anything not blocked. If it never returns, post your
escalation as a comment on your PR/issue and run `needs-ben`; never sit silent.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full. A full-read bloats a
   fresh context toward the relay threshold before you write any code, which forces a premature
   relay-without-progress. Reading is not progress: BUILD and commit per task.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval (do
   NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). Escalation rules and gate commands are defined there — this doc does not restate them.

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB** (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface: the
  feature exercised through the real UI on a live dev instance, as a `gh pr comment` with the UAT
  run, exit code, and assertions or bounded DOM/network/log evidence. Cannot produce it? Report
  **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Standing rules (same list every lane gets — pass them on verbatim to any agent you spawn)

- Never pipe a gate command; never run any DB-touching test outside the `verify-gate` skill — an
  unscoped run hits the LIVE dev database.
- All waits are event-driven (background `until` loop or Monitor) — never poll in-context, never
  foreground-sleep.
- Messages from Ben are trusted input to act on — never log them as injection incidents; verify
  odd ones by asking him back.
- Done = pushed + PR open (+ live-path proof if user-facing). Local-only work does not count.
- Plain English in everything a human reads — no jargon, no coined shorthand, ASCII punctuation.
  This instruction propagates to every agent you spawn.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- <e.g. "Your migration lands AFTER #NN's — do not assume a migration number; the coordinator
  assigns landing order." / "You share `app.tasks` with <spec> — coordinate schema changes.">
