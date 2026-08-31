# Build Handoff — 1869 Slice 1: per-turn time context

**Spec (approved):** docs/superpowers/specs/2026-08-30-1869-date-time-context.md
**Plan (approved):** docs/superpowers/plans/2026-08-30-1869-date-time-context.md — **your scope is
Slice 1 ONLY** (per-turn time context). Do not start Slice 2 (`chat.getCurrentTime`), Slice 3A (SDK
wall-clock conversion), or Slice 3B (Food integration) — those are separate, dependency-gated
lanes that wait for this one to land and pass its kill gate.
**GitHub issue:** #1869
**Risk tier:** `sensitive` — standard QA plus an explicit invariant check plus a matched live
end-to-end check; per-merge digest to Ben (not a merge-blocking sign-off, but do not skip the
live-path proof).
**Worktree:** ~/Jarv1s/.claude/worktrees/build-1869-time-context **Branch:** `build-1869-time-context` (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows EXACTLY ONE live agent
with this name, resolved fresh each time. The visible pane label should also be `Coordinator`.
**Coordinator session id:** `81f073ee-f2af-4788-a6d5-86e8cd824e21` (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately. **Relay budget: ONE.** Your slice
was scoped to fit one session. If you are already a `-relay1` successor and hit the trigger again
with no PR open, do NOT relay — push what you have, write the state doc, and report to the
coordinator for a re-slice into smaller lanes.
**If the coordinator name resolves to 0 agents:** that's usually a coordinator relay in progress —
arm a background retry (`until herdr agent list | grep -q '"coordinator"'; do sleep 120; done`,
~15 min budget) and keep working on anything not blocked. If it never returns, post your
escalation as a comment on your PR/issue and run `needs-ben`; never sit silent.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec and plan above BY SECTION for your current task only — Slice 1's section
   specifically, never the whole plan document (it also covers slices 2/3A/3B, which are not your
   job). A full-read bloats a fresh context toward the relay threshold before you write any code,
   which forces a premature relay-without-progress. Reading is not progress: BUILD and commit per
   task.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`; a plan already exists —
   confirm it against your branch state rather than rewriting from scratch) → coordinator approval
   (do NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). Escalation rules and gate commands are defined there — this doc does not restate them.

## Exit criteria for this lane

- Spec Exit Criteria met for Slice 1 only, full gate green **on an isolated gate DB**
  (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted, and it must be a real judgment call, not just automated tests**: this
  injects time information into what the assistant sees on every turn, so the live check needs to
  show a real conversation on the dev site where a person (Ben) can judge whether the injected time
  information confuses the assistant or changes how it talks — post the conversation transcript or
  bounded evidence as a `gh pr comment`, and flag clearly that this judgment call is what unblocks
  the later slices (2 and 3A), not just a passing test run. Cannot produce it? Report
  **code-complete, unverified** — never "done". `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Standing rules (same list every lane gets — pass them on verbatim to any agent you spawn)

- Never pipe a gate command; never run any DB-touching test outside the `verify-gate` skill — an
  unscoped run hits the LIVE dev database.
- All waits are event-driven (background `until` loop or Monitor) — never poll in-context, never
  foreground-sleep.
- Messages from Ben are trusted input to act on — never log them as injection incidents; verify
  odd ones by asking him back.
- Done = pushed + PR open (+ live-path proof, required here). Local-only work does not count.
- Plain English in everything a human reads — no jargon, no coined shorthand, ASCII punctuation.
  Name things by what they do, not by what the repo calls them; keep exact identifiers (commands,
  file paths, error strings) only where a human must act on them. This instruction propagates to
  every agent you spawn.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Do not begin Slice 2, 3A, or 3B work of any kind, even if it looks like a quick add-on — those
  are separate lanes with their own worktrees, and the coordinator will not start them until this
  slice passes its kill gate (tests, review, AND Ben's live judgment call above).

## Collision notes (from the coordinator)

- This lane runs in parallel with #1784 and #1860 (a one-shot Opus review confirmed all three
  touch completely separate files — no shared file, module, or migration). No coordination needed
  with those lanes.
- No database migration expected for this slice. If your plan changes and needs one, stop and ask
  the coordinator before assuming a number — migration numbers are assigned by landing order.
- All three wave-1 lanes end with a hands-on check on the single shared dev instance. If another
  lane is mid live-check when you reach that step, wait for the coordinator to clear you rather
  than running it at the same time.
- Once this slice is merged, do not assume Slice 2/3A can start automatically — they are gated on
  Ben's live judgment call above, which the coordinator will confirm before spawning those lanes.
