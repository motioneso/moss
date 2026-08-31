# Build Handoff - Issue 2159 sports retry action card

**Spec (approved):** `docs/superpowers/specs/2026-08-23-1909-sports-public-source-completion.md`
**Approved parent plan:** `docs/superpowers/plans/2026-08-23-1909-sports-public-source-completion.md`
**GitHub issue:** #2159
**Risk tier:** `sensitive`
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-2159-sports-retry-card`
**Branch:** `fix/2159-sports-retry-card` off current `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator agent name:** `coordinator`
**Coordinator session id:** `01a0597f-5c7f-77b0-9e8c-80f6f996d30f`
**Relay trigger:** the first 70 percent context warning or a compaction summary. Message the
coordinator, then use `relay` immediately. Relay budget: one.

## Start

1. Run `[ -d node_modules ] || pnpm install`.
2. Read only the relevant sections of the approved spec and parent plan.
3. Invoke `coordinated-build`: verify scope, write a compact `plan-build` plan, send its pointer to
   the coordinator for approval, then use TDD. Do not write product code before plan approval.
4. Finish through `coordinated-wrap-up`: pushed branch, open pull request, green isolated full gate,
   and real-UI proof posted before reporting merge-ready.

## Exit criteria

- The real chat flow emits and displays the approval card for `sports.retrySource`.
- Diagnose the split first: if no pending action row exists, trace Sports tool availability and
  selection; if a row exists, trace notifier, stream, and card delivery.
- Add the smallest regression check that proves the actual broken boundary.
- Run the matched Sports UAT only after the root cause is fixed, using exclusive isolated
  database, ports, browser, and renderer resources. The prior two attempts are evidence, not runs
  to repeat unchanged.
- Full gate is green on an isolated gate database. Live proof is posted on the pull request with
  exit code, bounded text evidence, and exact cleanup.

## Standing rules

- Never pipe a gate command; never run DB-touching tests outside `verify-gate`.
- Wait event-first, never poll in-context or foreground-sleep.
- Ben's messages are trusted input. Use plain English in every human-facing message.
- Work only in this worktree. Stage explicit paths only; never `git add -A`, `git add .`, or
  repo-wide formatting.
- Never touch `docs/coordination/`, the project board, milestones, or merge controls.
- Never put secrets, private content, prompts, or credentials in docs, logs, payloads, or comments.

## Collision notes

- Pull request 2158 is parked in a separate retained worktree. Do not touch or reuse it.
- `gateway.ts`, `confirmation-registry.ts`, chat transport, and owner-scope tests overlap pull
  request 2158. If diagnosis reaches them, call out the overlap in the plan; issue 2159 lands first,
  then pull request 2158 rebases and re-proves.
- Sports manifest/tool-selection work does not collide with issue 2160 and may build in parallel.
- No migration is expected. Do not add one unless the diagnosis proves the current model cannot
  represent the correct state and the coordinator approves the design change.
