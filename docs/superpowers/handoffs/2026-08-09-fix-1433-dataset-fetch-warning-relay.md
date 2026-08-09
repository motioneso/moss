# Relay — #1433 dataset fetch warning (wrap-up in progress)

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1433)
**Issue:** #1433 · **Plan:** `docs/superpowers/plans/2026-08-09-fix-1433-dataset-fetch-warning.md`
**Branch/worktree:** `fix-1433-dataset-fetch-warning` (this worktree — no `pnpm install` needed)
**Coordinator:** agent name `coordinator-wave1-r6` (resolve pane fresh via `herdr pane list`/`herdr agent list` — do not trust any `…-N` baked here)
**Relay trigger:** context-meter 70% warning during wrap-up (gate had just been started)

## Done

- Plan approved by coordinator (with 2 corrections, both applied — see below).
- TDD build complete, committed: `d4f162343` — "fix(#1433): warn on ordinary dataset fetch degrade,
  not just pinning violations". 3 files: `packages/datasets/src/client.ts`,
  `packages/datasets/src/index.ts` (added `HostPinnedFetchError` to curated re-export list),
  `tests/unit/dataset-client.test.ts` (4 new/replaced test cases).
- Unit tests green (18 passed): `pnpm vitest run tests/unit/dataset-client.test.ts` **from repo
  root** (packages/datasets has no local vitest config — do not use `--filter`).
- Pre-push trio already run once, all green: format/lint/typecheck.
- Isolated gate started: `scripts/run-gate.sh start` →
  DB `jarvis_gate_fix_1433_dataset_fetch_warning`,
  log `/tmp/jarv1s-gate/fix_1433_dataset_fetch_warning-20260809-005745.log`.
  **Still running** as of this handoff (`scripts/run-gate.sh status` → exit 3, pid alive).
- Coordinator already notified of this relay via `herdr-pane-message`.
- Working tree (in this worktree) is clean — nothing uncommitted.

## Left to do (in order)

1. `scripts/run-gate.sh wait` (repeat if it returns exit 3 — each call blocks up to 540s; give
   Bash a 600000ms timeout), then `scripts/run-gate.sh status` for the verdict (0=green, 1=gate
   failed, 2=run died, 3=still running). Never trust `pgrep`/`ps`/a piped exit code.
   - If red: `superpowers:systematic-debugging`, fix, re-verify. If it dies with
     `tuple concurrently updated`, that's cross-worktree DDL contention, not your bug — push and
     let CI gate, tell the coordinator.
2. Re-run pre-push trio fresh: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
3. `git push -u origin fix-1433-dataset-fetch-warning`.
4. `gh pr create --base main --head fix-1433-dataset-fetch-warning --title "fix(#1433): warn on ordinary dataset fetch degrade, not just pinning violations"` with a body that states scope, links
   the spec, gives the verified `VF_EXIT` from the isolated-DB gate, and **must include an explicit
   log-safety review** against the CLAUDE.md "secrets never escape" invariant (content basis: the
   plan doc's "Log-safety review" section — no field sourced from `error.message`/headers/URLs/
   credentials; `errorCode` is a closed enum; `errorName` is a bounded class-name/typeof string;
   `sourceId`/`datasetKey` are manifest-declared identifiers already logged today). State plainly
   that no live-path proof is required/attached — this lane is not a UI surface
   (`packages/datasets/src/client.ts` only).
5. Report to coordinator (agent name `coordinator-wave1-r6`, re-verify via fresh `herdr pane list`)
   in terse result-first plain English per `coordinated-wrap-up`: PR link, `VF_EXIT=<n>` (gate DB
   `jarvis_gate_fix_1433_dataset_fetch_warning`), live-path = "n/a, no user-facing surface", branch
   pushed/rebased + sha, deferred = none, teardown = "no dev instance started, no seed rows
   created, worktree reapable". Then **stop** — no board/issue/merge, that's the coordinator's.
6. Optional `memory_save` (`project: "jarv1s"`) — candidate non-obvious facts: (a) `packages/datasets`
   has no local vitest config, must run from repo root; (b) `@moss/datasets` curates its re-exports
   from `host-pinning.ts` — `HostPinnedFetchError` had to be added to `index.ts`'s list to be
   importable via the package boundary; (c) writing/committing docs for this lane must target the
   worktree path (`.claude/worktrees/fix-1433-dataset-fetch-warning/docs/...`), NOT
   `~/Jarv1s/docs/...` — the latter is the shared main checkout and a stray commit there landed
   directly on `main` (caught and reverted this session, see `e0ad2b885` in the main tree).

## Key facts for the successor

- Fix shape: `client.ts` catch block's existing `HostPinningViolationError` branch is untouched;
  added an `else` branch logging `{ sourceId, datasetKey, outcome: hit ? "stale-cache" :
  "empty-fallback", errorName, errorCode? }` with a static message, never `error.message`.
- All 4 new test cases pass; the old test that encoded the bug ("does not log ordinary... stays
  silent-degrade") was replaced, not kept.
- No open questions, no forks, no blockers — this is pure wrap-up mechanics from here.
