# Relay handoff — #1513 [1137-B2] serialize concurrent edits per note path

**Spec:** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` § B2 (lines 113-141).
**Plan (approved by coordinator, committed):** `docs/superpowers/plans/2026-08-18-1513-notes-mutex.md`
**Issue:** #1513. **Tier:** routine. **Branch/worktree:** `1513-notes-mutex` (this worktree).
**Coordinator label:** `Coordinator` (pane resolves via `herdr pane list`, session id
`b1aa5379-b1e8-46aa-9349-48b149a68dec` at time of writing — re-resolve, don't trust that value).

## Done

- Plan written and approved by coordinator. Committed at `0526f9b2f` along with the handoff doc.
- No production or test code written yet.
- Gate DB `jarvis_gate_1513notesmutex` created on the shared Postgres container (`CREATE DATABASE`
  already run) but **not yet exported** — `export JARVIS_PGDATABASE=jarvis_gate_1513notesmutex`
  still needs to happen in whatever shell runs vitest.

## What's left (in order)

1. **Write the two tests** into `tests/integration/notes-write-tools.test.ts`, new
   `describe("concurrent edits")` block placed after the existing tests (existing TOCTOU tests
   around lines 589-669 are the pattern to mimic — same `vi.mock("node:fs/promises", ...)` +
   `vi.hoisted` seam, `realpathMock`/`readFileFsMock`).

   **Corrected barrier design (supersedes the plan doc's vaguer wording — do not follow the plan
   doc's "readFileFsMock blocks until second call enters readFile" language literally, it
   deadlocks once the mutex is correctly implemented):**

   Put the deterministic barrier on **`realpathMock`**, specifically the `realpath` call inside
   `resolveExistingFile` (`packages/notes/src/write-tools.ts:119`) — this call happens **before**
   lock acquisition in the planned implementation (lock wraps pre-read guard → read → count check
   → pre-write guard → write; `resolveExistingFile` stays outside the lock, matching the plan's
   seams check). Gating on `realpath` guarantees both concurrent `notesEditExecute` calls have
   genuinely entered the function and are racing to acquire the lock, before either can possibly
   reach the locked critical section — no deadlock risk regardless of whether the mutex is
   implemented correctly or missing entirely.

   Test cases (full contract in the plan doc's "Test cases" section, lines 46-67):
   - **Test 1 — disjoint overlapping edits both succeed.** Seed a file with two distinct unique
     substrings, fire two concurrent `notesEditExecute` calls (different `oldText`/`newText`
     pairs), assert both resolve and the final file contains both replacements.
   - **Test 2 — same-substring overlap: exactly one succeeds, one gets 409.** Seed one occurrence
     of a substring, fire two concurrent edits targeting that same `oldText` with different
     `newText`. Assert one resolves, one rejects with `HttpError` matching `/appears 0 times/`, and
     the file contains exactly one complete result (not a merge/corruption).

2. **Confirm RED** against the current unmodified `write-tools.ts`: run just this test file (see
   verification commands below) and confirm test 2 specifically shows the lost-update bug (2
   fulfilled instead of 1 fulfilled + 1 rejected). Do this BEFORE writing `withPathLock` — it's the
   proof the test exercises the real bug.

3. **Implement `withPathLock`** in `packages/notes/src/write-tools.ts` per the plan's Decision
   section (lines 23-44): module-local `Map<string, Promise<void>>`, FIFO promise-chained lock
   keyed on the resolved absolute file path, delete the key on release only if no later waiter
   replaced the tail entry. Add the `ponytail:` comment above it (ceiling: single-API-process
   only, matches the convention at `packages/memory/src/embedding-cache-lock.ts:67-68`). Wire it
   into `notesEditExecute` (`packages/notes/src/write-tools.ts:211-240`): wrap pre-read guard →
   read → count check → pre-write guard → write in `withPathLock(file, async () => {...})`;
   `resolveExistingFile` stays outside/before the lock, `sync(...)` stays outside/after.

4. **Confirm GREEN**, confirm no other existing tests in the file broke.

5. **Pre-push trio + rebase** (per `coordinated-build` step 3b):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```

6. **Gate run**: export the gate DB first (it already exists, just needs export):
   ```bash
   export JARVIS_PGDATABASE=jarvis_gate_1513notesmutex
   pnpm exec vitest run tests/integration/notes-write-tools.test.ts > /tmp/1513-vitest.log 2>&1; echo "EXIT=$?"
   ```
   Expected `EXIT=0`. Also run `pnpm --filter @moss/notes typecheck > /tmp/1513-typecheck.log 2>&1; echo "EXIT=$?"`,
   expected `EXIT=0`. DROP the gate DB (`jarvis_gate_1513notesmutex`) when fully done, per
   `verify-gate` cleanup.

7. **Commit** (task-scoped, explicit paths — this is a shared checkout, see `shared-checkout`
   skill: `git diff` any co-edited file before committing, commit by explicit path, then
   `git show --name-only HEAD` to confirm).

8. **`coordinated-wrap-up`**: clean tree, push, open PR. This is backend-only concurrency
   behavior — **no live-UI proof required** per the original handoff doc's explicit note (no user-
   facing surface changes). State that plainly in the PR body. Report PR + verified evidence to
   the coordinator (label `Coordinator`, re-resolve pane fresh), then stop — coordinator owns
   QA/merge/board/close.

## Notes

- No lock package should be added — spec forbids it, plan confirms none exists in
  `packages/notes/package.json` or `pnpm-lock.yaml`.
- Kill gate: none needed past phase 1 (plan doc, line 82-85) — single-phase, single-file change.
