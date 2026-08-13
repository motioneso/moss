# Build Handoff — 1590-notes-sync-worker-isolation

**GitHub issue:** #1590 — root fix for the prod worker→Postgres connection-timeout incident
(#1589). **Spec:** `docs/superpowers/specs/2026-08-13-1590-notes-sync-worker-isolation.md` —
approved by Ben directly (drafted and sent via Telegram, reviewed personally — bypassed the usual
Fable first-pass, see the spec's Process notes). Read the spec in full before starting; it is
short and grounds every claim against source at commit `198928da4` — re-verify nothing has moved
since (branch is now based on `origin/main` @ `0c185619`, newer than the spec's grounding commit;
diff the key files listed in the spec's "Grounded on" section against current `main` before
trusting its line numbers).

**Risk tier:** `sensitive` (per the spec — cross-cutting worker-runtime change, no RLS/migration/
secrets surface). Standard QA + explicit invariant check + matched e2e-UAT + per-merge digest to
Ben. No merge-sign-off pause required (Fable is this run's sign-off delegate — see agentmemory
`fable-signoff-delegation-waves-3-6`).

**Model:** Codex, `gpt-5.6-luna`, `model_reasoning_effort=high` (Ben's explicit directive this
run — see manifest 2026-08-13 entry).

**Scope:** exactly the spec's "Exclusive owned surface" section — do not restructure other
modules' job registration in `apps/worker/src/worker.ts` beyond what's needed.

**Worktree:** `.claude/worktrees/1590-notes-sync-worker-isolation`
**Branch:** `1590-notes-sync-worker-isolation` (off `origin/main` @ `0c185619`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan reviewer:** none required — the spec itself is Ben-approved and locks the fix contract; a
short implementation plan is still expected per `plan-build` before writing code, but does not
need external sign-off — proceed once you've written it (self-approve against the spec's locked
contract, do not wait idle for a review that isn't coming).

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec in full (it's short — that's the point). Read `apps/worker/src/worker.ts`,
   `packages/notes/src/jobs.ts`, `packages/memory/src/local-embedding-provider.ts`,
   `packages/memory/src/embed-chunks.ts`, `packages/news/src/personalization-repository.ts`
   against **current** `origin/main`, not the spec's cited line numbers (they may have drifted).
3. Investigate the one open question the spec flags before picking direction: whether the ONNX
   inference call actually blocks Node's event loop or merely saturates CPU badly enough to starve
   it via OS scheduling — write a tiny throwaway repro if needed, then pick (a) `worker_thread`
   offload (preferred default) or (c) thread-count cap + explicit yields as a companion. **Do not
   build direction (b) (separate OS process)** — that requires a separate Ben/Fable call per the
   spec; if (a)+(c) together prove insufficient in your reproduction test, STOP and escalate to the
   Coordinator instead of building it.
4. TDD build per `coordinated-build`: reproduction test first (event-loop-delay measurement via
   `perf_hooks.monitorEventLoopDelay()` or a heartbeat counter — must be red on current `main`,
   green after your fix; no flaky real-timeout-based test), then the four locked fix-contract
   items in the spec's priority order, committing per step.
5. Report done to the Coordinator per `coordinated-wrap-up`.

## Exit criteria

All 8 items in the spec's "Focused acceptance" checklist, specifically:
- Reproduction test red-on-main, green-after-fix, committed.
- `notes.sync` still ingests correctly (existing notes-sync test suite green, no chunk/embedding
  regressions).
- Oversized ingest runs are fully processed across multiple job runs, not dropped.
- `news_refresh_state` reaches `'failed'` (not stuck `'queued'`) on a mid-run death — covered by a
  focused test.
- `EMBED_MAX_TOKENS` (512) and `EMBED_CONCURRENCY` (4) unchanged.
- No change to `JARVIS_DB_CONNECT_TIMEOUT_MS` shipped in this PR.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- Live-path proof: a real large-vault ingest on live dev, run concurrently with another queue's
  job, showing the other job completes normally — screenshot/log excerpt as a `gh pr comment`.
- PR open, rebased on `origin/main`.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.
- Do not raise `JARVIS_DB_CONNECT_TIMEOUT_MS` — explicitly out of scope (spec item 4).
- Do not build a separate OS process (direction b) without escalating first.

## Collision notes

- `apps/worker/src/worker.ts`: read-mostly wiring for every other lane tonight — touch only the
  registration call site your fix needs, nothing else.
- `packages/memory/*`: PR #1606 (#1248, vault ingestion) also touches this package
  (`vault-ingest-registry.ts`, different files) and is mid-rework on a separate branch — no direct
  file overlap identified, but rebase onto latest `origin/main` right before opening your PR in
  case that lands first.
