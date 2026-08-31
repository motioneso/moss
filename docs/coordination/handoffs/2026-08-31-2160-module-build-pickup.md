# Build Handoff - Issue 2160 module-build job pickup

**Spec (approved):** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`
**Approved parent plan:** `docs/superpowers/plans/2026-08-30-1902-module-tools-live.md`
**GitHub issue:** #2160
**Risk tier:** `sensitive`
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-2160-module-build-pickup`
**Branch:** `fix/2160-module-build-pickup` off current `origin/main`
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

- Establish from the pg-boss queue row and all connected workers which worker claimed the stuck
  build job and why the build never resolved. One proof worker's silent log alone is insufficient.
- Fix the root cause once at the shared queue/build state boundary. Preserve metadata-only job
  payloads and module isolation.
- Add the smallest regression check that would fail for the proven stuck-job path.
- Run the real module-build/chat-tool proof only after the root cause is fixed, with exactly one
  worker connected to its database and exclusive database, ports, module directories, browser, and
  CLI home. Preserve bounded evidence before cleanup.
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

- Do not reuse either pull request 2101 proof worktree. They contain preserved, untracked proof
  scripts and are not implementation worktrees.
- Pull request 2101 may overlap only in `apps/worker/src/worker.ts`; its manifest-source edit is a
  separate area. Issue 2160 lands first, then pull request 2101 rebases and re-proves.
- Issue 2159 is code-independent and may build in parallel. Live proofs are serialized.
- No migration is expected. Reuse the existing module-build and pg-boss tables. Do not invent a
  per-instance queue or schema without queue-row evidence and coordinator approval.
