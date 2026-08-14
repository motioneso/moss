# 1248 vault-ingestion — relay 4 continuation (§1-§2 built+committed, §3-§8 remain)

Spec: `docs/superpowers/specs/2026-08-12-1248-internal-vault-ingestion.md`
Plan: `docs/superpowers/plans/2026-08-12-1248-vault-ingestion.md` (Phase 1, lines 40-121)
**Primary build reference (still the target — read its numbered sections by task, not front to
back):** `docs/superpowers/handoffs/2026-08-12-1248-vault-ingestion-relay2.md`
**All relay2 UNVERIFIED points already resolved — do not re-verify, just use:**
`docs/superpowers/handoffs/2026-08-12-1248-vault-ingestion-relay3.md`

Worktree/branch: this worktree, `1248-vault-ingestion`. Coordinator label: `Coordinator` (resolve
fresh via `herdr pane list` — session id is authority, not pane number). Coordinator already
notified of this relay.

**I relayed at the 70% context-meter warning after completing relay2/3's build-order steps §1 and
§2 (committed). No new blockers found — go straight to §3.**

## Done this session (committed, do NOT redo)

- `23b7b3cbc` — `packages/vault/src/vault-ops.ts` + `index.ts`: added `listVaultOwnerIds`
  (reuses existing `isMissingPathError` helper for the ENOENT/ENOTDIR check — simpler than relay2's
  pseudocode, same behavior). Exported from `packages/vault/src/index.ts`.
- `a76c0d4dd` — `packages/memory/package.json`: added `@moss/jobs: workspace:*` and
  `pg-boss: ^12.18.2` (matches `packages/notes/package.json`'s existing versions exactly). Ran
  `pnpm install` — resolved clean, no circular dep (`@moss/jobs` does not depend on `@moss/memory`).
  `pnpm-lock.yaml` diff committed alongside.

## Confirmed this session (small additions to relay3, use directly)

- `packages/memory/src/index.ts` already exports: `MemoryRepository`, `MemoryIngestPipeline`,
  `EmbeddingProvider` (type), `VaultIngestRootProvider` (type, from `vault-ingest-registry.js`),
  plus `registerVaultIngestRootProvider`/`listVaultIngestRootProviders`/`isPathIngestable`/
  `resolveIngestRoots`/`HARD_EXCLUDED_PREFIXES` (Task 1, already built) — grep line 18-25 of
  `index.ts` for the exact re-export block before adding new ones for `vault-ingest-jobs.ts`.
- `packages/memory/src/ingest.ts` `MemoryIngestPipeline` confirmed exact (read in full this
  session): constructor `(embeddingProvider, repository)`; `ingestFile(scopedDb, vaultCtx,
  relativePath, options?)`; `deleteFile(scopedDb, ownerUserId, sourcePath)`. Matches relay2/3
  exactly — `purgeDeletedFiles` still confirmed NOT to use (purges against all `.md`, not the
  allowlist).
- `packages/vault/src/vault-ops.ts` and `packages/vault/src/index.ts` both hit the **known
  pre-existing TS6059 rootDir typecheck issue** (same class as `@moss/memory`'s, confirmed in
  relay2) when run as `pnpm --filter <pkg> typecheck` standalone — cross-package `@moss/db`
  imports resolve outside the filtered package's `rootDir`. Did not block on it (relay2 already
  flagged this as pre-existing/non-blocking, to double check at wrap-up via full `pnpm
  verify:foundation`). Don't waste time re-diagnosing per-package typecheck failures during the
  build — check the *root* gate at wrap-up instead.

## Next steps — resume relay2/relay3's build order exactly

**You are about to start §3** (relay2 section header "### 3. NEW
`packages/memory/src/vault-ingest-jobs.ts`" — the bulk of the work, TDD against the 6 test cases
listed under relay2's "## Task 2 test cases"). Then §4 → §5 → §6 → §7 → §8 → Task 3 e2e → pre-push
trio → `coordinated-wrap-up`, all per relay2/relay3's already-resolved design. Nothing new to
research — build straight through.

**Before writing `vault-ingest-jobs.ts`:** `packages/notes/src/jobs.ts` was read in full this
session (confirms relay2/3's description of the
`handleNotesSyncJobWithDataContext`/`registerNotesJobWorkers` split is accurate) — re-read it
yourself if you want the exact pattern in front of you, or trust relay2/3's description and build
directly; both are equally valid, just don't burn a relay cycle re-deriving what's already
described.

## Run-specific bans (unchanged)
- Never touch `docs/coordination/` on this branch.
- `git add` scoped to explicit task files only — never `-A`/`.`.
- Never assume a migration number (none needed).
