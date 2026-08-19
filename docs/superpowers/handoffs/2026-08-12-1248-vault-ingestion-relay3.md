# 1248 vault-ingestion — relay 3 continuation (Task 2: all unknowns resolved, ZERO code written)

Spec: `docs/superpowers/specs/2026-08-12-1248-internal-vault-ingestion.md`
Plan: `docs/superpowers/plans/2026-08-12-1248-vault-ingestion.md` (Phase 1, lines 40-121)
Prior handoff (Task 2 design, still the primary reference):
`docs/superpowers/handoffs/2026-08-12-1248-vault-ingestion-relay2.md` — **build exactly what it
specifies.** This doc only resolves the points it flagged UNVERIFIED, plus a few more found along
the way. Do not re-read relay2 in full if you already have it; jump to its section headers by task.

Worktree/branch: this worktree, `1248-vault-ingestion`. Coordinator label: `Coordinator` (resolve
fresh via `herdr pane list` — session id is authority).

**I relayed at the 71% context-meter warning having only verified relay2's open questions — no
file writes, no commits. Go straight to writing code.**

## Verified this session (do NOT re-derive, just use)

1. **`PeopleNotesServiceDeps`** (`packages/people/src/notes-service.ts:53-56`): currently
   `{ preferencesRepository?, peopleRepository? }` — no `boss` field yet. Add
   `readonly boss?: PgBoss` per relay2 §5. Constructor at line 122 just does `deps.x ?? new X()` —
   trivial to extend the same way (`this.boss = deps.boss`).
2. **`writeVaultFile` call sites**: `createPersonNote` line 228, `updatePersonNote` line 264 —
   confirmed, matches relay2.
3. **notes/jobs.ts separation pattern** (relay2 §3, "grep before writing"): confirmed exact shape.
   `handleNotesSyncJobWithDataContext` (pure, takes `job, dataContextRunner, embeddingProviderFactory,
   preferencesRepository`, does its own `withDataContext` calls internally, returns result) is
   fully separate from `registerNotesJobWorkers` (the `boss.work(...)` wrapper that also handles
   the last-sync side-write). Mirror this exactly: `runVaultIngestSweep` = pure/testable (per
   relay2 §3 pseudocode, already fully specified there), `registerVaultIngestWorkers` = the
   `boss.work` wrapper.
4. **`createRuntimeEmbeddingProvider` signature** (relay2 §7 open question): confirmed via
   `module-registry/src/index.ts:1447` — used directly as `embeddingProviderFactory:
   createRuntimeEmbeddingProvider` with NO wrapping. It already matches `(scopedDb) =>
   Promise<EmbeddingProvider>`. So `VaultIngestWorkerDeps.embeddingProviderFactory` can be set to
   it directly at the wiring site; call it as `deps.embeddingProviderFactory(scopedDb)` inside a
   `withDataContext` callback (same as `defaultEmbeddingProviderFactory` in notes/jobs.ts:417-423).
5. **Module hook optionality** (relay2 §7, structured-state check): confirmed —
   `module-registry/src/index.ts:2377` `module.registerRoutes?.(server, deps)` and `:2428`
   `module.registerWorkers?.(boss, dependencies) ?? Promise.resolve([])`. Both fully optional,
   safely absent today on structured-state (`:1587-1591`, bare descriptor, no hooks at all).
6. **Module descriptor exact current state** (for the diffs in relay2 §7):
   - memory: `:1533-1547`, `queueDefinitions: []`, has `registerRoutes` only, no `registerWorkers`.
   - structured-state: `:1587-1591`, bare `{manifest, sqlMigrationDirectories, queueDefinitions: []}`.
   - people: `:1830-1849`, `registerRoutes` builds `peopleNotesService: new PeopleNotesService()`
     (line 1840, **no boss** — this is the "wired not just defined" gap relay2 §5 flags),
     `registerWorkers` at `:1842-1848`. `deps.boss` is already in scope (used at `:1838`).
7. **`packages/jobs/src/pg-boss.ts` exports confirmed**: `sendJob<T extends ActorScopedJobPayload>
   (boss, queue, payload, options?)` (line 137, applies `assertMetadataOnlyPayload` internally),
   `assertMetadataOnlyPayload` (line 120), `toAccessContext(job)` (line 339, throws if
   `actorUserId` missing/non-UUID — confirms tick handler must NOT go through it), `QueueDefinition`
   (line 30), `ActorScopedJobPayload` (line 22, just `{actorUserId}`).
8. **`boss.schedule` global (non-keyed) pattern**: `packages/notes/src/schedule.ts` uses a
   **per-actor** keyed schedule (`key: actorUserId`) — NOT the pattern for the tick queue. For
   `VAULT_INGEST_TICK_QUEUE`, relay2 §3 point 3 is correct: call `boss.schedule(...)` ONCE with NO
   `key` (single global schedule) inside `registerVaultIngestWorkers`, not per-actor.
9. **`MemoryRepository.listIndexedPaths(scopedDb, ownerUserId, sourceKind)`**
   (`packages/memory/src/repository.ts:272-285`) confirmed exists, returns `Promise<string[]>` of
   `source_path`. Use directly — matches relay2 §3's fix note (pass `repository` as its own param
   to `runVaultIngestSweep`, don't reach into the pipeline).
10. **`MemoryIngestPipeline`** (`packages/memory/src/ingest.ts`): `ingestFile(scopedDb, vaultCtx,
    relativePath, options?)` (derives `ownerUserId` from `vaultCtx.actorUserId` internally) and
    `deleteFile(scopedDb, ownerUserId, sourcePath)` — both confirmed, exact signatures relay2
    assumed. **Do NOT use `pipeline.purgeDeletedFiles`** — it purges against ALL `.md` files, not
    the allowlist-filtered set; the custom purge loop in relay2 §3 (using `allFiles` = the
    allowlist-filtered list already computed) is correct and required.
11. **`packages/vault/src/vault-ops.ts`**: `readdir` is ALREADY imported (line 1, full list:
    `chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile`) — relay2 §1's "if not, add
    it" check: not needed, just add the `listVaultOwnerIds` function using the existing import.
    `deleteUserVaultDir` (operator-level, unscoped) is at line 205 as relay2 said — good precedent
    to sit `listVaultOwnerIds` next to.

## Not yet checked (do at build time, not now)

- Exact `PgBoss` type import path for `packages/people/src/notes-service.ts` (relay2 §4 flags
  `@moss/jobs` may be missing from `packages/people/package.json` deps — verify and add if so).
- `EntitiesRepository.listVisible` shape for structured-state provider (relay2 §6) — not touched
  this session, still exactly as relay2 described it, unverified.

## Everything else

Unchanged from relay2 — its full design (queue names, exact handler logic, provider
implementations, wiring points, 6 test cases, Task 3 e2e, known non-blocking typecheck issue,
post-build trio + wrap-up steps, run-specific bans) is still the build target. Read relay2's
numbered sections (1-8) as you implement each piece; you now have every previously-open question
answered above so you can build straight through without re-deriving anything.

**Build order suggestion:** relay2 §1 (vault-ops helper, tiny) → §2 (package.json deps) → §3
(vault-ingest-jobs.ts, the bulk of the work, TDD against the 6 test cases) → §4 (people provider)
→ §5 (notes-service nudge wiring + `PeopleNotesServiceDeps.boss`) → §6 (structured-state provider)
→ §7 (module-registry wiring, all three descriptors) → §8 (grep-cite) → Task 3 e2e → pre-push trio
→ `coordinated-wrap-up`.

## Run-specific bans (unchanged)
- Never touch `docs/coordination/` on this branch.
- `git add` scoped to explicit task files only — never `-A`/`.`.
- Never assume a migration number (none needed).
