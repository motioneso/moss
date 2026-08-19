# #1554 persistent-provider-chat-runtime — relay #12

Task #7 (e2e-P2 "reap is real") done. Commit: `a10487de8`.

## What was built

- `tests/integration/persistent-pool-reap.test.ts` — new, 3 tests, following the plan's exact
  3-step scenario (~lines 345-377 of `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`):
  1. cap=2 pool admits 2 real persistent sessions (real `ClaudePersistentRuntime`, real spawned OS
     child processes, verified via `ps -p <pid>` + `ps -p <pid> -o command=` — never logs); a 3rd
     session is denied and falls back to `ClaudePrintChatEngine` (checked via `instanceof` +
     `isBoundedFallbackEngine("anthropic","non_interactive")`, also structural, not a log line).
  2. `pool.sweepIdle()` real-kills session 1's OS process (confirmed gone via polled `ps`) while
     leaving session 2 (never turned, stays "ready" not "idle") untouched — proven via the pool's
     own injected `clock` seam advanced past the threshold, no real wall-clock wait.
  3. A 4th session is admitted as persistent again (`pool.size()` back to 2, new real OS process),
     proving the reaped slot was reclaimed.
- `tests/integration/fixtures/persistent-pool-fake-cli.mjs` — new. A real, separately-spawned Node
  process (not a mock/log fixture) standing in for the `claude` binary via
  `ClaudePersistentRuntime`'s own `spawnChild` test-injection seam (its doc comment literally says
  "Injected for tests"). Reads stdin JSON lines, writes back the same stream-json shape
  `tests/unit/claude-persistent-runtime.test.ts`'s `emitAssistantReply` helper already proves the
  real decoder accepts, and stays alive (real interval, default SIGTERM handling) until killed —
  giving `ps` a genuine PID/command line and a genuine kill to observe.
- `package.json` — `"test:persistent-pool": "tsx scripts/test-integration.ts tests/integration/persistent-pool-reap.test.ts"`,
  matching the plan's exact intended invocation and the existing `test:chat`-style convention.

## Deliberate scope note — read before assuming token revocation is missing

The plan's e2e-P2 text (line ~356-358) is explicit: "Token revocation is NOT asserted here — it's
covered by Decision 2's in-process test cases, which run against the real `SessionTokenRegistry`
instance." Task #6 (relay-11, commit `21723cde5`) already built and passed those 4 in-process
cases (`tests/unit/chat-routes-mcp-token-revoke-adopt.test.ts` + related). This file does not
duplicate that assertion — it is scoped exactly as the plan specifies: real child-process lifetime
+ pool-slot reclamation only. (The task-#7 dispatch prompt I received paraphrased this as "reap
revokes the session token via a real call to revokeBySessionId" — that paraphrase conflicts with
the plan's own text; per the plan being sole-authoritative and the instruction not to re-litigate
it, I followed the plan, not the paraphrase.)

Also not tested here (out of the plan's literal 3 steps, by design): LRU-evict-triggered reap
(`"lru-evict"` reason) — cap enforcement in step 1 only exercises *denial*, not eviction of an
already-idle occupant. That code path is presumably covered by the existing in-memory unit tests
for `PersistentRuntimePool` (fake-runtime based, not this file's concern).

## Verification

- `npx tsc --noEmit -p .` from repo root: exit 0, no output.
- `npm run test:persistent-pool > /tmp/e2e-p2.log 2>&1; echo "EXIT=$?"` → **EXIT=0**. Log tail:
  `Test Files 1 passed (1)`, `Tests 3 passed (3)`, ~800ms test time — real assertions, not
  skipped/no-op.
- `ps aux | grep persistent-pool-fake-cli` after the run: empty — `afterAll` cleanly reaped every
  tracked fixture process, no orphans left running.
- No TaskGet/TaskUpdate tools present in this session's toolset (same gap relay-10/relay-11 hit) —
  could not mark task #7 completed via tooling; recording completion here instead.
- Shared-checkout discipline followed: `package.json` diffed before staging (only my one added
  line was present — no concurrent edits from another session landed on it), committed by explicit
  path (never `-A`/bare commit), `git show --name-only HEAD` confirmed exactly the 3 intended files.

## Next: task #8 (NOT started)

Pre-push trio (whatever that resolves to per the coordinator's current definition — not assumed
here), rebase onto `origin/main`, `verify-gate` skill, push, open PR, report back to the build
coordinator. Re-resolve the coordinator fresh via `ListAgents`/herdr pane list — do not trust any
stale agent name/ref from this or prior relays. Do not push, open a PR, or touch the GitHub
board/issue from this relay — out of scope per this task's explicit instructions.
