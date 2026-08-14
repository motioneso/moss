# #1248 vault-ingestion — relay9 continuation

PR #1606, branch `1248-vault-ingestion`, this worktree. QA verdict (RED, 4 blocking findings):
https://github.com/motioneso/moss/pull/1606#issuecomment-5284804690

Coordinator label: **Coordinator** — resolve fresh via `herdr pane list` (label + `agent_session.value`),
never a `…-N` number from this doc. Note: on relay8→relay9 handoff the pane holding that label
turned out to be a **codex** agent named `coordluna`, not the claude coordinator seen earlier in
the same session — pane occupants for a label are not stable, always re-resolve.

## Done (all 4 QA findings' code-level work complete + green in isolation)

1. Rebased onto `origin/main` clean, zero conflicts.
2. `normalizeRoot`/`isPathIngestable` fixed in `packages/memory/src/vault-ingest-registry.ts` —
   collapses `..`/`.` via `path.posix.normalize`, rejects escapes. Commit `59603a762`.
3. Integration-level non-allowlisted-path test added to `tests/integration/vault-ingest-jobs.test.ts`.
   Commit `b27199a42`.
4. **New this relay:** that same test had a test-pollution bug — asserted `stats.processed` (a
   sweep-wide count) which also picked up an unrelated leftover un-indexed `bad.md` fixture from an
   earlier test in the same shared-vault `describe` block. Not a security regression — the real
   invariant (outside-root file never indexed) held throughout. Fixed the assertion to check the
   security-relevant invariants directly (indexed-paths list, `failed[]` membership for the
   outside-root path) instead of the global count. Verified via a scoped run — `pnpm db:migrate`
   against a fresh DB + `npx vitest run tests/integration/vault-ingest-jobs.test.ts` directly — all
   8 tests in that file passed (rc=0). Committed as **`29e612b0b`**, path-scoped, diff reviewed,
   `git show --name-only HEAD` confirmed only this one file. Full diff is in the commit.

## Resolved false blocker — read before re-investigating

`pnpm --filter @moss/memory typecheck` (and `@moss/people`) fails with TS6059 rootDir errors on an
**unmodified tree** — pre-existing, repo-wide false-negative of per-package `--filter typecheck`,
not a real break. Root `pnpm typecheck` is the source of truth and is green. Writeup:
`~/.claude/.../memory/pnpm-filter-typecheck-tsrootdir-false-red.md`.

## Gate status — NOT yet green on a clean run, this is the next blocking step

Two gate attempts so far, both against `GATEDB=jarvis_gate_1248vault`:

- **1st attempt**: RED on the test-pollution bug above (finding #4). Fixed, verified in isolation,
  committed (`29e612b0b`).
- **2nd attempt** (full `pnpm verify:foundation` after that fix): RED on two files **unrelated to
  this branch's diff** — `tests/integration/briefings-action-rows.test.ts` (SQL COMMIT error during
  DB reset) and `tests/integration/finance-storage-migrate.test.ts` (`role
  "jarvis_mod_finance_install" is not permitted to log in`). My diff touches neither briefings nor
  finance-storage. Diagnosis: matches the known, previously-documented **cluster-global Postgres
  role contention** pattern (`pg-roles-are-cluster-global` in agentmemory) — `JARVIS_PGDATABASE`
  isolates the database but role/catalog DDL is cluster-global, so concurrent gate runs from other
  fleet sessions on the shared Postgres container can corrupt/contend for shared roles mid-run.
  Corroborated: `herdr pane list` at the time showed "1585 news stale AI ranking (Luna)" and "1590
  notes-sync worker isolation (Luna)" both `agent_status: working`, i.e. plausibly gating
  concurrently. This has been reported to the Coordinator already (relay8→9 status message) — no
  coordinator action requested unless it wants to arbitrate gate-run ordering across the fleet.

**Not yet re-verified with a clean, single-owner gate window.** Next step for whoever picks this up:

1. `herdr pane list` — confirm no other session shows `agent_status: working` on a DB-touching gate
   (per `verify-gate` skill's stagger guidance). Also plain `ps aux | grep verify:foundation` as a
   second check.
2. DROP + CREATE `jarvis_gate_1248vault` fresh again (do not reuse — carries the failed 2nd
   attempt's state). Follow the `verify-gate` skill exactly (export, not inline; log to file with
   `### FINAL rc=` sentinel; never pipe).
3. If it goes green: proceed to the pre-push trio below.
4. If it's RED again on `briefings-action-rows` / `finance-storage-migrate` specifically (same two
   files) with nothing touching those areas in this branch's diff: that's the same known cluster
   contention, not a new bug — don't chase it as a #1248 regression. If it's RED on anything else,
   or on those same two files but you can rule out concurrent fleet activity, treat it as real and
   investigate.

## What's left, in order

1. Confirm/rerun the gate green (see above — currently blocking).
2. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (root-level, not filtered) +
   `git fetch origin main && git rebase origin/main`.
3. **Push needs `--force-with-lease`, not a plain push** — local `1248-vault-ingestion` was rebased
   onto a newer `origin/main` by an earlier relay, rewriting commit SHAs, so local and
   `origin/1248-vault-ingestion` have diverged. Confirm via `herdr pane list` / a heads-up per
   `shared-checkout` that no other session is mid-push/mid-rebase on this branch first.
4. Run the 2 blocking UAT specs on a **live dev instance** (not headless):
   - `tests/uat/specs/1217-uat-vault-ownership.uat.spec.ts`
   - `tests/uat/specs/module-install.uat.spec.ts`

   **Coordinator instruction received this relay (2026-08-13): screenshots are no longer wanted for
   UAT/live-path proof on this run.** Do NOT generate/capture/attach/preserve screenshots. If any
   screenshot artifacts get generated as a side effect of running the specs, delete them before
   commit — don't let them land in the repo or the PR comment. Report **exit codes plus bounded
   DOM/network/log/database evidence** instead (e.g. relevant assertion output, a scoped `psql`
   query confirming the DB state, relevant log lines — bounded, not full unbounded dumps per the
   box-wide context-diet rule). This changes the evidence *format* only — **do not weaken the
   live-path assertions themselves**; the specs must still actually exercise the feature through
   the real UI on a live dev instance, same rigor as before, just proved without screenshots.
   Post that evidence as a PR #1606 comment per `coordinated-wrap-up` skill's "Live-path proof"
   section (adapted: no screenshots, per the above).
5. Message the Coordinator (label "Coordinator", re-resolve fresh): new HEAD sha + proof-comment
   link, ready for re-QA. **Never merge/board/close yourself.**

Also at your discretion (non-blocking): the QA verdict comment has 8 non-blocking notes, not yet
read/actioned.

## Explicitly NOT your job

- `chat-drawer-surface.test.tsx` CI flake, tracked as #1607 — someone else's, escalated to Fable
  via the Coordinator already. Don't re-investigate.

## Worktree / branch

- This directory, branch `1248-vault-ingestion`, HEAD `29e612b0b`. `node_modules` already
  installed — do not `pnpm install`. Working tree is clean.
