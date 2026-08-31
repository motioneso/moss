# Relay 2 — issue 1869, slice 1 (per-turn time context)

Spec: `docs/superpowers/specs/2026-08-30-1869-date-time-context.md`
Plan: `docs/superpowers/plans/2026-08-30-1869-date-time-context.md` — your scope is the
"Slice 1 - fresh `<current_time_context>` on every turn" section ONLY (search that heading; do
not read the whole plan). Do not start slices 2, 3A, or 3B.
Branch/worktree: `build-1869-time-context`, this same worktree. `node_modules` already present —
skip `pnpm install`.
Coordinator: herdr agent name `coordinator` — confirm exactly one live agent with that name via
`herdr agent list` before messaging it. It has already approved the plan and was told this relay
was coming.
Relay depth: this is relay 2 (the prior relay's own trigger fired with no PR open, which per the
one-relay budget means the slice needed re-scoping — but it is now very close to done, so finish
it in this session rather than re-slicing). If your own context-meter 70% warning fires again with
no PR open, stop, push what you have, and tell the coordinator this needs to be re-sliced into
smaller pieces — do not relay a third time.

## What is done (all committed)

- `packages/chat/src/live/time-context.ts` — the pure formatter for the `<current_time_context>`
  block. Done, not touched this relay.
- `packages/chat/src/live/engine-text.ts` — restructured so the time block always precedes
  whatever else is sent to the assistant. Done, not touched this relay.
- `packages/chat/src/live/chat-session-manager.ts` — added `now?: () => Date` to
  `ChatSessionManagerDeps` (a comment there explains it is deliberately separate from the existing
  `clock` field, which measures idle/heartbeat time, not wall-clock instants) and threaded it into
  the `buildEngineText` call inside `runTurn`.
- `tests/unit/chat-engine-text.test.ts` — 8 tests, all passing.
- `tests/unit/chat-session-manager.test.ts` — fixed 3 pre-existing tests that broke because the
  time block now prefixes every engine submission, and added the key proof test: two `submitTurn`
  calls on the same session with the clock moved across the person's local midnight, asserting the
  two texts sent to the engine carry different correct local dates, the session was not relaunched
  (`engine.launchCount === 1`), and the persona file was written exactly once (byte-stable, no
  dates leaking into the fixed introduction text). All 37 tests in this file pass.
- `tests/unit/chat-live-manager.test.ts` — **NOT a Slice 1 file per the plan's ownership table**,
  but running the full unit suite showed 10 of its tests broke for the same reason (they assert
  the exact text handed to a fake engine). Added a shared `NOW` constant and `withTime(text)`
  helper near the top of the file (right after the imports), plumbed `now: () => NOW` into every
  place a `ChatSessionManager` is constructed, and fixed 8 of the 10 broken tests. **2 remain
  broken as of this commit** — see below.

Commits so far (most recent last): `b2feeec86`, `96641a0f2`, `56838a503`.

## What is NOT done yet — next steps, in order

1. **Fix the last 2 broken tests in `tests/unit/chat-live-manager.test.ts`:**
   - `"rejects a concurrent turn for the same user (turn-at-a-time) and recovers afterwards"`
     (currently around line 692) — it asserts `expect(reply).toBe("reply to: first")` and
     `expect(next.reply).toBe("reply to: third")`. The `ChatSessionManager` in this test is built
     directly (not via the shared `makeManager` helper) and is missing `now: () => NOW` in its
     deps object — add it, then wrap the expected strings the same way every other fix in this
     file did: `` `reply to: ${withTime("first")}` `` etc.
   - `"allows concurrent turns for DIFFERENT users (lock is per-actor)"` (currently around line
     731) — same shape: add `now: () => NOW` to its `ChatSessionManager` deps, then find whatever
     literal-text assertions it has on the two engines' submitted/reply text and wrap them in
     `withTime(...)` the same way.
   - Use the pattern already applied 8 times in this file as your reference — grep for `withTime(`
     to see every prior fix, they are all the same shape.
2. **Fix `tests/unit/chat-session-manager-selfheal.test.ts`** — 2 failing tests, not yet looked
   at:
   - `"heals a dead engine: evicts, relaunches with forced replay, resubmits once"`
   - `"heals a failed LAUNCH once"`
   These almost certainly need the same treatment: find how `ChatSessionManager` deps are built in
   this file, add `now: () => <some fixed Date>`, and fix any exact-text assertions on what was
   submitted to the fake engine to account for the time block now being prepended. Read the
   failure output first (`pnpm test:unit tests/unit/chat-session-manager-selfheal.test.ts`,
   unpiped, check exit code) rather than guessing blind.
3. **Run the full unit suite once more** to confirm nothing else broke:
   `pnpm test:unit > /tmp/1869-full-test.log 2>&1; echo "EXIT=$?"` (don't pipe; check the exit
   code, then read the log file). Fix anything still red. This full-suite run is not one of the
   plan's named "Slice 1 verification" commands but it is necessary — the time-block change is
   cross-cutting and the plan's own two-file check missed this.
4. **Run the plan's actual Slice 1 verification checklist** (search the plan file for "Slice 1
   verification" — it's short, 4 commands: the two named test files, `tsc --noEmit`, an `eslint`
   command naming exactly 5 files, and `pnpm format:check`). Run each unpiped, check the exit code.
5. Then follow `coordinated-wrap-up`: the pre-push trio (`pnpm format:check && pnpm lint && pnpm
   typecheck`, then `git fetch origin main && git rebase origin/main`), the proper test-database
   gate (only through the `verify-gate` skill, never a raw command), push the branch, open the
   pull request, and post a real live demonstration — an actual conversation on the dev site
   showing the assistant behaves sensibly with the time information now included — as a comment on
   the pull request. State plainly that this live-path result is the judgment call that decides
   whether issue 1869 slices 2 and 3A can start.

## Facts already confirmed — don't re-derive these

- This worktree was brought fully up to date with the main branch before any code was written; no
  other changes are mixed in.
- The two production files (`time-context.ts`, `engine-text.ts`) and the `chat-session-manager.ts`
  seam are done and match the plan exactly.
- There is an unrelated "clock" used elsewhere in `chat-session-manager.ts` for idle/heartbeat
  timing. Do not reuse it for the `now` seam — they are deliberately separate.
- The `chat-live-manager.test.ts` and `chat-session-manager-selfheal.test.ts` breakage is real
  collateral damage from a correct, intentional change (the plan says the time block goes in front
  on every path) — it is in scope to fix as part of finishing Slice 1, not a sign something is
  wrong with the implementation.
