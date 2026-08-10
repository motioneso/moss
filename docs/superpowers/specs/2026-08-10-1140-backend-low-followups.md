# Backend low-severity follow-ups

**Date:** 2026-08-10

**Status:** Approved by Ben's Fable delegate on 2026-08-10

**Roll-up issue:** #1140

**Source:** findings #11, #14, #15, #16, #20, #23, and #40 in
`docs/audits/2026-07-17-bug-hunt-sequential.md`

**Grounded on:** `origin/main` = `ba1acd70a`, issue #1140, and
`docs/coordination/2026-08-10-follow-up-wave-decomposition.md`

**Pre-build grounding gate:** rebase each child on the then-current `main`, re-run the focused
caller/file check for its owned surface, and replace any stale line references before implementation.
For B, assign the next globally free built-in migration number at build time. Never edit an applied
migration.

## Decision summary

#1140 remains a roll-up and receives no implementation PR. File the six build children 1140-A
through 1140-F exactly as locked below. Finding #40 is superseded and produces no 1140-G build
child; record its evidence on the parent issue when filing the six children.

The fixes reuse the existing stores, repositories, process entrypoints, and socket/PTY seam. They
add no dependency, framework, feature flag, public API, or speculative shared abstraction.

The mandatory ordering is:

```text
parallel-ready: 1140-A, 1140-B, 1140-C, 1140-E
1140-C -> 1140-D
1140-E -> 1140-F
```

A, B, C, and E may run in parallel because their owned surfaces are disjoint. D starts after C
because both change CLI-runner contracts and fixtures. F starts after E because both serially own
`apps/api/src/server.ts`.

## Current-state grounding

The codebase graph found the production symbols and inbound paths for the preview store,
`SportsFollowsRepository.create`, `CliChatEngineHost.cancelSubmit`, `safeWrite`, and both crash
handlers. A current-tree check supplied newer job-search code absent from that graph index.

| Finding | Current behavior at the draft baseline                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #11     | `createPreviewStore.put` enforces ten entries per owner but never removes expired entries; expiry is checked only by `take`.                                                                                                                                                                                                                                                                                             |
| #14     | `SportsFollowsRepository.create` performs a read-before-insert for `team_key IS NULL`; migration 0133's ordinary UNIQUE constraint still treats NULLs as distinct, so two concurrent creates can both insert.                                                                                                                                                                                                            |
| #15     | `cancelSubmit` creates a `{ digest: null }` tombstone for every unseen attempt id. Tombstones preserve cancel-before-submit ordering but live until launch or kill clears the session ledger.                                                                                                                                                                                                                            |
| #16     | terminal output flows `TerminalSession.onData` → `TerminalHost` → `TerminalSink` → `safeWrite`; `ByteChannel.write` is typed `void`, `safeWrite` ignores the native boolean, and `TerminalSession` exposes no pause/resume methods even though `node-pty` supports both.                                                                                                                                                 |
| #20     | API and worker crash listeners both call an unlatched handler. A rejection/exception cascade can start multiple shutdown promises, timers, logs, and exits.                                                                                                                                                                                                                                                              |
| #23     | `GET /api/modules` returns `error.message` for two account-state codes. The two constructors are fixed today, but the mapper does not enforce that boundary. Similar mappers exist elsewhere, with no shared account-state mapper.                                                                                                                                                                                       |
| #40     | The cited `domain/evaluations.ts` 25/day KV ledger was deleted by the clean-slate job-search replacement. Current scoring instead has `AI_CALL_BUDGET = 200` per invocation, a platform cap of 500 host AI calls per invocation, and a ten-minute worker deadline. Manual queue singleton dedupe lasts five seconds and does not serialize a full run; scheduled queues and the direct assistant tool can still overlap. |

## Shared scope and release rules

- Each child fits one implementation session, one focused PR, and the exact owned files listed for
  it. A builder must not absorb a sibling finding.
- A child may adjust a listed test fixture mechanically when its owned production type changes. Any
  unlisted production file requires a spec amendment, not opportunistic cleanup.
- Keep private-data, metadata-only-job-payload, module-isolation, provider-agnostic-AI, and
  `VaultContext` invariants unchanged.
- B is **sensitive migration tier**. F is **security tier**. All other children use routine QA.
- These fixes add no user-facing feature. A focused live smoke is useful for D and E where practical,
  but the feature live-path gate does not justify combining the children into one oversized UAT.
- Every PR reports its focused commands and the normal repository gate required at implementation
  time. Database commands run only through the repository's verify-gate procedure.

## 1140-A: sweep expired news previews

**Tier:** routine.

**Dependencies:** none.

**Exclusive owned surface:**

- `packages/news/src/discovery/preview-store.ts`
- `tests/unit/news-preview-store.test.ts`

### Locked implementation contract

At the start of `put`, read `now()` once and delete every map entry whose age is greater than
`ttlMs`. Then run the existing per-owner oldest-first cap and insert the new preview unchanged.
Expiry remains `age > ttlMs`, matching `take`'s current inclusive validity at exactly `ttlMs`.

The sweep is global, not limited to the owner performing the new put: otherwise ten abandoned
entries per inactive owner still remain forever. Keep the existing in-memory `Map`, option shape,
random UUIDs, owner scoping, and single-use `take`. Do not add a timer, background job, heap, global
cap, cache class, or dependency.

### Focused acceptance

- A put by owner B removes an expired abandoned preview belonging to owner A.
- An entry exactly `ttlMs` old remains valid; one `ttlMs + 1` old is gone.
- The existing per-owner cap still evicts only that owner's oldest live entry.
- Run `pnpm vitest run tests/unit/news-preview-store.test.ts`.

## 1140-B: make whole-league sports follows unique

**Tier:** sensitive migration; owner-only RLS classification is unchanged.

**Dependencies:** none, except coordinator-assigned migration landing order.

**Non-blocking builder requirement:** this does not block filing or dispatch, but the builder must
add an explicit upgrade-path harness that stages duplicate NULL-team rows _before_ the new migration
runs. A normal fresh-DB reset is insufficient because it applies every migration before test setup.
Add the harness to the listed sports integration test, using the ledger-removal/reapply precedent in
`tests/integration/job-search-tables-install.test.ts`: in an isolated test database, remove only the
new migration's `app.schema_migrations` row, drop only its partial index, seed duplicates, and rerun
the sports migration directory. Do not simulate the cleanup after the index already exists.

**Exclusive owned surface:**

- `packages/sports/src/repository.ts`
- `packages/sports/src/manifest.ts`
- `packages/sports/sql/<NNNN>_sports_whole_league_unique.sql`
- `tests/unit/sports-manifest.test.ts`
- `tests/integration/sports-follows-repository.test.ts`
- `tests/integration/foundation-schema-catalog.test.ts`

### Locked migration contract

Add one sports-owned append-only migration; never edit `0133_sports_follows.sql`. Before creating the
index, collapse existing whole-league duplicates with `row_number()` partitioned by
`(owner_user_id, competition_key)` where `team_key IS NULL`, keeping the deterministic first row by
`created_at ASC, id ASC`. The rows are semantically identical follows, so no user state beyond the
duplicate rows is discarded.

Then create a partial unique index over `(owner_user_id, competition_key) WHERE team_key IS NULL`.
Use `IF NOT EXISTS` for the index. Keep all four owner-only FORCE-RLS policies and grants unchanged.
Append the migration to the sports manifest and foundation schema catalog using the actual
build-time number.

### Locked repository contract

Replace the race-prone read-before-insert sequence with one insert using `ON CONFLICT DO NOTHING`
and `RETURNING`. If the insert returns no row, re-read the exact owner-scoped
`competition_key`/`team_key` row and return it, throwing if the supposedly conflicting row is absent.
Use untargeted `DO NOTHING` so the same code also handles the existing non-NULL UNIQUE constraint;
do not add a transaction, retry loop, lock, or second repository method.

### Focused acceptance

- The explicit upgrade harness stages duplicate NULL-team rows before reapplying the new migration;
  it leaves the oldest deterministic survivor, recreates the partial index, and restores the
  migration ledger row.
- The ordinary fresh-DB gate still installs all sports migrations cleanly and is idempotent when no
  upgrade data exists.
- Concurrent creates for one actor and competition return the same id and leave one row.
- Different owners may each follow the same whole league; team-specific uniqueness remains intact.
- Manifest/catalog tests name the newly assigned migration without changing 0133.
- Run the sports manifest/unit test and the sports follows real-DB integration test through the
  verify-gate procedure.

## 1140-C: bound cancel-only submit tombstones

**Tier:** routine.

**Dependencies:** none; D waits for this child.

**Exclusive owned surface:**

- `packages/cli-runner/src/engine-host.ts`
- `tests/unit/cli-runner-server.test.ts`

### Locked implementation contract

Keep cancel-before-submit preemption: the newest unseen cancellation must still create a
`digest: null` tombstone so a delayed matching submit rejects as `unavailable` and never reaches the
engine. Bound only these synthetic tombstones per session key with a fixed FIFO ceiling of **128**.
Before inserting the 129th synthetic tombstone, delete the oldest `digest === null` entry. Never
evict a real submitted attempt (`digest !== null`) and do not alter active-attempt abortion.

Do not add timeouts, a second ledger, timestamps, an LRU class, or global cleanup. Launch and kill
continue clearing the entire session ledger as today. The 128-entry ceiling is deliberately local
and non-configurable; revisit only if a real client can demonstrate more than 128 legitimate
cancel-before-submit races in one live session.

### Focused acceptance

- Existing active-submit cancellation and one cancel-before-submit case remain green.
- After 129 unseen cancellations, the oldest tombstone no longer blocks its delayed submit, the
  newest still does, and no real submitted-attempt entry was evicted.
- Launch/kill still clears the bounded ledger.
- Run `pnpm vitest run tests/unit/cli-runner-server.test.ts`.

## 1140-D: propagate terminal socket backpressure to the PTY

**Tier:** routine infrastructure.

**Dependencies:** after 1140-C.

**Exclusive owned surface:**

- `packages/cli-runner/src/connection.ts`
- `packages/cli-runner/src/terminal-host.ts`
- `packages/cli-runner/src/terminal-session.ts`
- `tests/unit/cli-runner-terminal-host.test.ts`
- `tests/unit/cli-runner-protocol.test.ts`
- `tests/unit/cli-runner-terminal-rpc.test.ts`

### Locked implementation contract

Expose `TerminalSession.pause()` and `resume()` as direct wrappers over the already-installed
`node-pty` methods. Make `TerminalSink.data` report whether the socket accepted the write. When a
live session's data write returns exactly `false`, `TerminalHost` pauses that same PTY. A socket
`drain` event resumes only the recorded terminal id whose write returned false, and only if that id
is still live. Do not resume whichever terminal happens to be current: a drain belonging to an
evicted terminal must be a no-op for its replacement.

Update `ByteChannel.write` to reflect the native boolean while permitting existing void-returning
test doubles (`boolean | void`); only an exact `false` means backpressure. Add the `drain` event to
the channel contract. Distinguish a thrown write from backpressure: a thrown write closes the
connection, while `false` pauses the PTY and leaves the bytes in the socket's own bounded buffer.
Ordinary request/response frames keep their existing close-on-write-error behavior and must not
mistake `write() === false` for data loss.

No module-owned queue is added: the socket buffer is the queue. Do not copy PTY chunks into an
array, retry a chunk, drop bytes, reset the idle policy, or resume a session whose terminal id is no
longer live.

### Focused acceptance

- A fake channel returning false for terminal data causes one PTY pause and no byte retry/drop.
- Repeated PTY emissions while paused do not create an application queue.
- Emitting `drain` resumes the same live PTY once; a drain after eviction/close does not resume the
  replacement or killed PTY.
- A thrown channel write still closes and kills the connection-owned terminal.
- Existing real-PTY open/write/echo/kill coverage remains green.
- Run the three listed CLI-runner terminal/protocol unit files.

## 1140-E: make crash shutdown single-flight

**Tier:** routine process-lifecycle.

**Dependencies:** none; F waits for this child.

**Exclusive owned surface:**

- `apps/api/src/server.ts`
- `apps/worker/src/worker.ts`
- `tests/unit/process-crash-handlers.test.ts` (new)

### Locked implementation contract

Give each process one closure-local `crashing` latch shared by its `unhandledRejection` and
`uncaughtException` listeners. The first crash sets the latch before logging or starting shutdown.
Later crash notifications return immediately: one fatal log, one `server.close()`/worker
`shutdown()`, one two-second timer, and one `process.exit(1)`.

Move only the smallest handler factory needed to make each closure deterministic under unit test;
keep API and worker shutdown mechanics local to their current files. Inject only the existing
shutdown, logger, timeout, and exit effects needed by the test. Do not create a cross-package crash
manager, alter SIGINT/SIGTERM's clean exit path, change timeout durations, or swallow the first
error.

### Focused acceptance

- Calling each generated crash handler twice before shutdown settles invokes log, shutdown, timer,
  and exit once.
- The first label/error is the one logged; later crashes cannot replace it.
- A hanging shutdown still exits 1 after two seconds; a prompt shutdown exits 1 without waiting.
- Existing API signal-shutdown and worker lifecycle tests remain green.
- Run the new focused unit test plus `tests/unit/api-signal-shutdown.test.ts` and
  `tests/integration/worker-lifecycle.test.ts` through the appropriate gate.

## 1140-F: return fixed account-state error text

**Tier:** security.

**Dependencies:** after 1140-E because both serially own `apps/api/src/server.ts`.

**Exclusive owned surface:**

- `apps/api/src/server.ts`
- `tests/integration/auth-settings.test.ts`

### Locked implementation contract

In the `GET /api/modules` account-state catch, map codes to these exact literals:

| Code                       | Response error                 |
| -------------------------- | ------------------------------ |
| `account_pending_approval` | `Account is pending approval`  |
| `account_deactivated`      | `Account has been deactivated` |

Keep status 403 and the existing `code` field. Never read `error.message` for these responses.
Unknown errors keep the existing scrubbed 401 response.

Do not sweep `packages/ai/src/terminal-routes.ts`, `packages/settings/src/route-error.ts`, or
`packages/settings/src/routes-serializers.ts` in this child. The current tree has no shared
account-state mapper, so touching them would widen ownership and duplicate this PR's proof. File a
separate security hardening issue if a later audit requires all module-route mappers to converge;
do not create a helper for that hypothetical work here.

### Focused acceptance

- Pending and deactivated actors receive the exact 403 literals and codes above from
  `GET /api/modules`.
- Tests pin the literal response, not the exception constructor's message.
- An unknown auth failure still returns `Session is missing or expired` and never its message.
- Run the focused auth-settings cases through the verify-gate procedure.

## Finding #40 disposition: superseded; no 1140-G child

Ben's Fable delegate approved the superseded option. Finding #40 described a legacy product
contract: 25 AI evaluations per owner per UTC day, stored in KV by `takeBudget`. That implementation
and its evaluation records were deleted by clean-slate commit `6f82554ed`. Current scoring instead
uses `AI_CALL_BUDGET = 200` per invocation, the platform's 500-call invocation guard, and a
ten-minute deadline. There is no current daily budget for concurrent work to overrun.

Record that evidence on parent issue #1140 and close finding #40 as superseded. Do not file 1140-G,
write code, add a table, or create a documentation-only runtime promise. The five-second manual
queue singleton and the lack of KV CAS remain current implementation facts, not defects against a
daily contract that no longer exists.

If a future product/cost issue explicitly approves a daily limit, the reserved starting shape is
**200 score-model calls per owner per UTC date**, atomically reserved before each scoring call with
one module-owned SQL `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE used < 200 RETURNING` CAS.
That future design would share the cap across crawl-run, crawl-sweep, direct run-now, criteria
continuation, and résumé rescoring; failed score-model calls would consume their reservation and an
exhausted reservation would return `usage_limited` without calling the provider. This paragraph is
design input for a new issue and spec, not an approved Jarv1s runtime contract.

## Roll-up exit

#1140 can close when A-F are merged and independently verified and the parent records finding #40's
superseded evidence. The roll-up records links to all six children and states that the ten Info-grade
audit nits remain documentation-only. No child may claim a broader security, throughput, or
paid-cost guarantee than its locked acceptance proves.
