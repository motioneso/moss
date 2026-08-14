# 1248 vault-ingestion — relay continuation

Spec: `docs/superpowers/specs/2026-08-12-1248-internal-vault-ingestion.md`
Plan: `docs/superpowers/plans/2026-08-12-1248-vault-ingestion.md` — read BY SECTION only.
Worktree/branch: this worktree, `1248-vault-ingestion`.
Coordinator label: `Coordinator` (resolve fresh via `herdr pane list`; session id
`caef4e32-df22-4310-a42d-866771a0ba6c` at time of writing — session id is authority, pane number
reflows).
Handoff doc (original): `docs/coordination/handoffs/2026-08-13-1248-vault-ingestion.md` (lives on
coordinator branch `coord/overnight-20260810`, not merged to main — read via `git show
0736e2d37:docs/coordination/handoffs/2026-08-13-1248-vault-ingestion.md` if not present here).
Scope: **Phase 1 ONLY.** Do not start Phase 2 (Ben-owned kill gate after a day on dev) or Phase 3
(blocked on #1556). Report Phase 1 done to Coordinator and STOP.

## Done (committed)

- **Task 1** — commit `517a41072`: `packages/memory/src/vault-ingest-registry.ts` +
  `tests/unit/vault-ingest-registry.test.ts` (9/9 passing), exported from
  `packages/memory/src/index.ts`. Allowlist registry: `VaultIngestRootProvider` interface,
  `HARD_EXCLUDED_PREFIXES = ["attachments/", "exports/"]`, `isPathIngestable`,
  `resolveIngestRoots` (belt-and-braces resolve-time throw), provider register/list.
- Spec/plan verified against live branch before build — all seams-table `file:line` citations
  current, no drift. Did not need to re-scope.

## Not started — Tasks 2 & 3

**Task 2:** `packages/memory/src/vault-ingest-jobs.ts` — sweep + nudge pg-boss jobs:
`VAULT_INGEST_SWEEP_QUEUE`, `VAULT_INGEST_NUDGE_QUEUE`, `VaultIngestNudgePayload`,
`registerVaultIngestWorkers`, `scheduleVaultIngestNudge`. Follow `registerDataContextWorker` +
`toAccessContext(job)` pattern from `packages/jobs/src/pg-boss.ts:330-350`, reference usage in
`packages/chat/src/jobs.ts:300-325`; scheduled-sweep precedent in `packages/notes/src/jobs.ts:25-60`
(15-min noOp-guarded schedule).

Wire providers + nudges:
- `packages/people/src/notes-service.ts` — `writeVaultFile` call sites at line 228
  (`createPersonNote`) and line 264 (`updatePersonNote`). Add `scheduleVaultIngestNudge` calls
  after both. **Nuance:** `archivePersonNote` (lines 273-280) is a soft-delete that reuses
  `updatePersonNote`'s same `writeVaultFile` site at line 264 — there is no separate hard-delete
  path for people-notes, so only upsert-nudges apply here, no delete-nudge call site exists.
  Register a `VaultIngestRootProvider` for the people module.
- `packages/structured-state/src/write-back.ts` — register a provider (registration-only, no live
  producer; `syncEntityToVault` no-ops today since nothing sets `vault_note_path` in prod —
  confirmed dormant, matches plan).

Test cases required by plan (6): allowlisted-write→sweep produces `source_kind='vault'` chunks;
second-sweep hash-skips to 0 new; delete-then-sweep purges chunks+file-index row; one-file-failure
isolated to that file (others still ingest); cross-owner RLS isolation; nudged-write retrievable
without waiting for sweep.

**Task 3:** Phase-1 e2e integration test against a real gate DB — create a people-note via
`PeopleNotesService`, run the sweep worker, assert chunks retrievable via
`MemoryRetriever.retrieve(..., "vault")`, then delete/archive and assert purge. For the eventual PR
description: grep-cite the production registration call site proving workers are actually wired
(not just defined) — the "wired-not-just-defined" review trap.

## Known non-blocking issue to carry forward

`pnpm --filter @moss/memory typecheck` fails with TS6059 rootDir errors (files under
`structured-state`/`usefulness-feedback`/`vault` pulled in transitively via `@moss/vault` imports
in `ingestion-service.ts`/`ingest.ts`). **Confirmed pre-existing / not a regression** — reproduced
identically on a clean stash of the pre-existing tree before any of this work. Not yet confirmed
whether the full `pnpm verify:foundation` gate (root tsconfig, not per-package filter) also hits
this. **Check at wrap-up** — if it does, that's a real finding to report, not something to
silently patch around; if the full gate is clean, it confirms this is a `--filter`-only tsconfig
quirk.

## After Tasks 2 & 3

1. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
2. Invoke `coordinated-wrap-up`: full isolated-gate-DB run via `verify-gate` skill, push, open PR
   (sensitive tier), double-check live-path gate applicability (Phase 1 is "no surfacing" per plan
   — likely exempt but confirm against the plan's own per-phase exit criteria, don't assume).
3. Report PR + verified evidence to Coordinator. **STOP — do not start Phase 2.**

## Run-specific bans (from original handoff)

- Never touch `docs/coordination/` on this branch.
- `git add` scoped to explicit task files only — never `-A`/`.`.
- Never assume a migration number (none needed for Phase 1 anyway — `source_kind` CHECK already
  includes `'vault'` in `packages/memory/sql/0106_memory_notes_source_kind.sql`).
