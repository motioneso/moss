# Build Handoff — 1585-news-stale-ai-ranking-failure

**GitHub issue:** #1585 — News content stuck stale in prod; current issue text describes a
`kept_last_good` fetch-failure path, but the latest read-only production diagnosis below found a
different active failure class.
**Spec:** None; this is an approved issue-driven root-cause lane. Use the issue plus this handoff
as the locked scope.
**Risk tier:** `sensitive` (AI/personalization pipeline and user-facing news refresh). Re-evaluate
to `security` immediately if the fix touches the AI gateway, capability-router auth, secrets, or
another network-exposed trust boundary.
**Model:** Codex `gpt-5.6-luna`, reasoning effort `high` (Ben's explicit directive for this lane).
**Worktree:** `~/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/1585-news-stale-ai-ranking-failure`
**Branch:** `1585-news-stale-ai-ranking-failure` (cut from `origin/main` at `0c1856190`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`; exactly one pane.
**Coordinator session id:** `019ffd3f-3098-73c0-bab8-31f491615168`

## Current diagnosis

The latest production read-only diagnosis in the run manifest (`docs/coordination/2026-08-10-
overnight-run.md`, 2026-08-13 `#1585` section) found:

- `app.news_refresh_state`: `state='failed'`, `failure_kind='ai'`.
- `requested_generation=193`, `compiled_generation=149` — 44 refresh attempts did not land.
- `app.news_compilation_snapshots.compiled_at='2026-08-08 01:19:36 UTC'`; the 7-day hard expiry
  leaves roughly 1.5 days of runway at diagnosis time.
- `packages/news/src/compilation/compile.ts` returns `failureKind: "ai"` when `rankCandidates()`
  in `packages/news/src/compilation/rank.js` returns `{ok:false}`. The first job is to narrow
  whether `deps.ai.generateJson(...)` is failing at the provider/gateway or its parse/schema
  validation is rejecting malformed output.

The issue's `kept_last_good` fetch-failure hypothesis remains relevant background, but do not
implement it blindly or declare the active incident fixed without tracing the observed `ai` path.
The prior diagnosis was posted to issue comment `5287107352`.

## Build ask

1. Read `CLAUDE.md`, this handoff, and issue #1585. Use the codebase graph for discovery when
   available; trace the real refresh → compile → rank → AI provider path before editing.
2. Reproduce or otherwise pin down the observed `failure_kind='ai'` failure with the smallest
   deterministic test or diagnostic evidence available. Distinguish provider/gateway errors from
   malformed JSON/schema output.
3. Implement the smallest root-cause fix that makes failed refreshes recover and prevents the
   user-facing snapshot from remaining stale. Preserve useful last-good behavior only where it
   is safe; do not hide repeated AI failures.
4. Add one focused regression test for the failure mode and keep existing news/AI tests green.
5. If the fix touches a user-facing path, produce the required live-path proof through the real UI
   on a live dev instance. If blocked, report `code-complete, unverified` with the exact blocker.
6. Follow `coordinated-build` and `coordinated-wrap-up`: explicit-path commits, isolated gate DB,
   rebase on current `origin/main`, open a PR, and report the PR plus evidence to the Coordinator.

## Escalation and bans

- Do not touch `docs/coordination/`, the project board, milestones, or merge anything yourself.
- Do not broaden into a generic news-refresh rewrite, add a cron, or change snapshot expiry unless
  the traced root cause requires it and the Coordinator approves the scope.
- Do not invent a provider, model, or "Sol" identity. If a genuine Fable-type design/security
  decision arises, notify the Coordinator; the Coordinator will ask Ben via `needs-ben` before
  choosing the authority. Until then, use the existing Opus/sensitive QA chain.
- Work only in this worktree/branch; use explicit `git add` paths and never repo-wide formatting.
- No secrets in docs, payloads, logs, or prompts.

## Collision notes

- The lane is cut from current `origin/main` after #1274/PR #1605. Rebase immediately before PR.
- Other active lanes may touch shared news or AI files. Resolve any overlap by rebasing and
  coordinating with the Coordinator; do not hand-edit another lane's work.
