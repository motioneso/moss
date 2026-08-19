# Build Handoff — #1327 briefing action-row UI

**Spec (approved):** `docs/superpowers/specs/2026-07-29-1327-briefing-action-rows.md`
**GitHub issue:** #1327
**Scope:** §9 Tasks 6–7 only
**Risk tier:** `security` — this lane crosses the external-link and confirmation-gated Reply
boundaries. Ben authorized the same rule used for #1376: fresh `gpt-5.6-sol high` approval plus
coordinator concurrence authorizes merge; any RED means no merge.
**Worktree:** `~/Jarv1s/.claude/worktrees/1327-action-row-ui`
**Branch:** `build/1327-action-row-ui`, based on terminal-green `origin/main` at `f810e45f`
**Build skill:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — resolve it fresh via `herdr pane list`; exactly one must exist.
**Coordinator session id:** `019fb9d9-8e73-7422-b7ff-67a7a5de94ec`
**Relay trigger:** context-meter 70% or any compaction summary → message the coordinator and invoke
`relay` immediately.

## Start

1. Run `[ -d node_modules ] || pnpm install`.
2. Read `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, and the spec only at §1, §8, §9 Tasks 6–7,
   §10–12. Do not deep-read unrelated sections or historical coordination notes.
3. Invoke `coordinated-build`. Ground the current UI flow with the codebase-memory graph tools,
   write the minimum plan for Tasks 6–7, and send its pointer to `Coordinator` for approval before
   writing feature code.
4. Build test-first, commit by task, push, open the PR with `Closes #1327`, and invoke
   `coordinated-wrap-up`.

## Locked scope

- Build `BriefingActionRowsSection` once and use it from both day and evening layouts; remove
  `today-suggested-email.tsx` only after every caller moves.
- Reuse the contracts and payload already on `main` from #1376 and the prose surface from #1374.
  Do not rebuild Tasks 1–5, add a second reply path, or add a migration.
- Reply must auto-send only the fixed literal instruction plus opaque `cacheMessageId`; the existing
  `email.draftReply` confirmation remains the write boundary. Never interpolate model or mailbox
  text into the chat instruction or a URL.
- Accept/Dismiss reuse the existing task transition and invalidate task plus briefing queries.
  View uses only `sourceHref` with safe external-link attributes.
- Extend existing `jds-brief`, `loose`, and `loose-row` primitives. No raw colors outside
  `tokens.css`, no mono or serif, and preserve authored loading/empty/stale states and accessibility.
- Task 7's e2e and the spec's live-path artifact are mandatory. Record the real dev-instance run
  and assertions or bounded DOM/network/log evidence on the PR. If credentials or live data block it, report
  **code-complete, unverified**; never waive or simulate the artifact.

## Run-specific bans

- Work only in this worktree/branch. Stage explicit paths; never `git add -A`, `git add .`, or run
  repo-wide `pnpm format`.
- Never touch `docs/coordination/`, project-board state, milestones, migrations, or merge controls.
- No secrets, mailbox contents, message identifiers, or private source URLs in docs, logs, tests,
  prompts, screenshots, or job payloads.
- Do not end a turn between declared steps. If a gate is running, keep the turn alive until it
  returns or explicitly hand control back to the coordinator.

## Collision notes

- No other #1327 build or QA lane is live. #1374 and #1376 are already on this branch's base.
- The live #1246 lane is unrelated. If your plan unexpectedly touches gateway policy, shared chat
  controls, or anything outside the Task 6–7 file surface, stop and ask `Coordinator` before coding.
