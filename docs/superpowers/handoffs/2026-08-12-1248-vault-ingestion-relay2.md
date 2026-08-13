# 1248 vault-ingestion — relay 2 continuation (Task 2 design done, ZERO code written yet)

Spec: `docs/superpowers/specs/2026-08-12-1248-internal-vault-ingestion.md`
Plan: `docs/superpowers/plans/2026-08-12-1248-vault-ingestion.md` (Phase 1 section, lines 40-121) —
read BY SECTION only, already fully digested below, don't re-read unless you need to double check.
Worktree/branch: this worktree, `1248-vault-ingestion`. Coordinator label: `Coordinator` (resolve
fresh via `herdr pane list` — session id is authority, not pane number).
Prior handoff (still valid, superseded by this one for Task 2 detail):
`docs/superpowers/handoffs/2026-08-12-1248-vault-ingestion-relay.md`.

**I relayed at the 70% context-meter warning having only researched/designed Task 2 — no file
writes, no commits. Don't waste time re-deriving the design below; it's already fully resolved
against the live branch. Go straight to writing code.** Follow `coordinated-build` step 2 (Build):
TDD, commit per task, `git add` scoped to task files only.

## Task 2 design (VERIFIED against live branch this session — build this exactly)

### 1. `packages/vault/src/vault-ops.ts` — add owner-enumeration helper (operator-level, like
`deleteUserVaultDir` at line 205 — NOT VaultContext-scoped, this is an admin/scheduler operation):

```ts
export async function listVaultOwnerIds(vaultsBaseDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(vaultsBaseDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
```
`readdir` already imported in that file's node:fs/promises import (check top of file — if not,
add it). Export from `packages/vault/src/index.ts` alongside the other vault-ops exports (line
~13 area).

### 2. `packages/memory/package.json` deps — add `"@moss/jobs": "workspace:*"` and
`"pg-boss": "^12.18.2"` (currently memory has neither; every other job-registering package does).

### 3. NEW `packages/memory/src/vault-ingest-jobs.ts`

Queues:
```ts
export const VAULT_INGEST_SWEEP_QUEUE = "memory.vault-ingest-sweep";   // payload: {actorUserId}
export const VAULT_INGEST_NUDGE_QUEUE = "memory.vault-ingest-nudge";
export const VAULT_INGEST_TICK_QUEUE = "memory.vault-ingest-tick";     // NEW, not in plan's literal
  // interface list but required to implement "scheduler tick enumerates owner dirs" (plan line 87-89).
  // Global (non-actor-scoped) queue — the tick handler lists ALL owner dirs and fans out one
  // VAULT_INGEST_SWEEP_QUEUE job per owner via sendJob(). This is the only clean way to do
  // cross-owner enumeration under pg-boss's per-actor RLS worker pattern (registerDataContextWorker
  // requires actorUserId in the payload; the tick, by definition, doesn't have one owner).
export const VAULT_INGEST_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  { name: VAULT_INGEST_SWEEP_QUEUE }, { name: VAULT_INGEST_NUDGE_QUEUE }, { name: VAULT_INGEST_TICK_QUEUE }
];
export interface VaultIngestNudgePayload extends ActorScopedJobPayload {
  readonly sourcePath: string;
  readonly op: "upsert" | "delete";
}
```

Deps interface (mirror `RegisterChatJobWorkersOptions` shape):
```ts
export interface VaultIngestWorkerDeps {
  readonly vaultRunner: VaultContextRunner;
  readonly vaultsBaseDir: string;
  readonly embeddingProviderFactory: (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;
  readonly repository?: MemoryRepository;  // default: new MemoryRepository()
  readonly sweepCron?: string;             // default: process.env.VAULT_INGEST_SWEEP_CRON ?? "*/15 * * * *"
}
```

**Sweep handler — use `boss.work` directly, NOT `registerDataContextWorker`.** Reason (same as
`packages/notes/src/jobs.ts`'s documented reasoning at its `registerNotesJobWorkers`): a sweep
processes N files, each needing ITS OWN transaction (matches `IngestionService.ingestVault`'s
existing per-file-txn design at `packages/memory/src/ingestion-service.ts:44-53`). Wrapping the
whole handler in one `registerDataContextWorker` transaction would serialize/deadlock exactly like
the notes.ts comment warns. Pattern:

```ts
async function runVaultIngestSweep(
  accessContext: AccessContext,
  vaultCtx: VaultContext,
  dataContext: DataContextRunner,
  pipeline: MemoryIngestPipeline
): Promise<{ processed: number; skipped: number; deleted: number; failed: IngestFailure[] }> {
  const ownerUserId = accessContext.actorUserId;
  const stats = { processed: 0, skipped: 0, deleted: 0, failed: [] as IngestFailure[] };

  // Aggregate roots across ALL registered providers for this owner (one dataContext call).
  const roots = await dataContext.withDataContext(accessContext, async (scopedDb) => {
    const all: string[] = [];
    for (const provider of listVaultIngestRootProviders()) {
      all.push(...(await resolveIngestRoots(provider, scopedDb, ownerUserId)));
    }
    return all;
  });

  const allFiles = (await listVaultFilesRecursive(vaultCtx)).filter((f) =>
    isPathIngestable(f, roots)
  );

  for (const path of allFiles) {
    try {
      const result = await dataContext.withDataContext(accessContext, (scoped) =>
        pipeline.ingestFile(scoped, vaultCtx, path)
      );
      if (result.status === "ingested") stats.processed += 1;
      else stats.skipped += 1;
    } catch (err) {
      stats.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Purge: any indexed 'vault' path NOT in the current allowlisted file set — covers true
  // deletes AND files that left the allowlist (root prefix changed/shrunk). Simpler than
  // re-checking isPathIngestable per indexed row: allFiles IS already "should be indexed".
  await dataContext.withDataContext(accessContext, async (scoped) => {
    const indexed = await (pipeline as any).repository // see note below re: repository access
      .listIndexedPaths(scoped, ownerUserId, "vault");
    const present = new Set(allFiles);
    for (const path of indexed) {
      if (!present.has(path)) {
        await pipeline.deleteFile(scoped, ownerUserId, path);
        stats.deleted += 1;
      }
    }
  });

  return stats;
}
```
**NOTE:** `MemoryIngestPipeline` does not expose its `repository` — pass a `MemoryRepository`
instance into `runVaultIngestSweep` as its own param instead of reaching into the pipeline (fix the
pseudocode above: add a `repository: MemoryRepository` param, call `repository.listIndexedPaths`
directly). Don't hack around pipeline internals.

Export `runVaultIngestSweep` (or keep it internal + export a thin wrapper) — **Task 2's 6 test
cases and Task 3's e2e test should call this function directly against a gate DB**, not spin up a
real pg-boss loop. Mirror the separation `packages/notes/src/jobs.ts` uses between
`handleNotesSyncJobWithDataContext` (pure, testable) and `registerNotesJobWorkers` (the `boss.work`
wrapper) — **grep that separation in notes/jobs.ts before writing this** to match the codebase's
established shape exactly (I described it from a partial read this session; confirm signatures).

**Nudge handler** — `boss.work` directly (not registerDataContextWorker — single actor per job is
fine either way, but keep consistent). Best-effort: catch everything, `console.error(JSON.stringify(...))`
on failure, **never rethrow** (a permanently-failing nudge must not retry-storm; sweep is the
backstop — plan line 92 "failure logs and defers to the sweep"). Re-check `isPathIngestable`
against the freshly-resolved roots before acting (defense in depth — don't trust the caller).
`op === "delete"` → `pipeline.deleteFile`; `op === "upsert"` → `pipeline.ingestFile`, each in its
own `dataContext.withDataContext` call.

**Tick handler** — plain `boss.work` on `VAULT_INGEST_TICK_QUEUE`, no data context (cross-owner,
operator-level — same class of operation as `deleteUserVaultDir`): `listVaultOwnerIds(vaultsBaseDir)`
then `sendJob(boss, VAULT_INGEST_SWEEP_QUEUE, { actorUserId: ownerId })` per owner (import `sendJob`
from `@moss/jobs` — applies `assertMetadataOnlyPayload` for you).

`registerVaultIngestWorkers(boss, deps)`:
1. registers sweep worker (`boss.work(VAULT_INGEST_SWEEP_QUEUE, ...)`, builds `vaultCtx` via
   `deps.vaultRunner.withVaultContext(accessContext, cb)` where `accessContext = toAccessContext(job)`,
   builds `embeddingProvider = await deps.embeddingProviderFactory(scopedDb)` — needs one
   `withDataContext` call first just to get a `scopedDb` for the factory, OR restructure factory to
   not need scopedDb up front; check `createRuntimeEmbeddingProvider`'s actual signature before
   assuming — used at `module-registry/src/index.ts:1445` for chat, confirm shape there);
2. registers nudge worker;
3. registers tick worker AND calls `boss.schedule(VAULT_INGEST_TICK_QUEUE, deps.sweepCron ?? "*/15 * * * *", {}, { tz: "UTC" })`
   once (idempotent upsert, no `key` — this is a single global schedule, not per-actor, unlike
   notes' per-actor `reconcileNotesSchedule`).
4. returns all registered work-ids.

`scheduleVaultIngestNudge(boss, payload)`: best-effort wrapper — `assertMetadataOnlyPayload(payload)`
then `sendJob(boss, VAULT_INGEST_NUDGE_QUEUE, payload)`, caught and logged, **never throws** (callers
in notes-service.ts must not fail a note write because nudge scheduling failed).

### 4. NEW `packages/people/src/vault-ingest-provider.ts`
```ts
export function createPeopleVaultIngestRootProvider(notesService = new PeopleNotesService()): VaultIngestRootProvider {
  return {
    moduleId: "people",
    async resolveRoots(scopedDb, ownerUserId) {
      const { folder } = await notesService.getSettings(scopedDb, ownerUserId);
      return folder ? [folder] : [];
    }
  };
}
```
Export from `packages/people/src/index.ts`. Add `"@moss/memory": "workspace:*"` to
`packages/people/package.json` deps (not currently present — verify; `@moss/jobs` may also be
missing, needed for the `PgBoss` type if you inject `boss` into `PeopleNotesService`, see below).

### 5. Wire nudges into `packages/people/src/notes-service.ts`
**UNVERIFIED — read `notes-service.ts:118-150` (constructor + `PeopleNotesServiceDeps`) before
touching this.** Plan: add optional `boss?: PgBoss` to `PeopleNotesServiceDeps`, store as
`this.boss`, and after each `writeVaultFile` call (line 228 in `createPersonNote`, line 264 in
`updatePersonNote`) do:
```ts
if (this.boss) {
  await scheduleVaultIngestNudge(this.boss, { actorUserId: ownerUserId, sourcePath: notePath /* or note.path */, op: "upsert" });
}
```
`archivePersonNote` reuses `updatePersonNote` — no separate call (confirmed prior session, no
delete-nudge path exists for people-notes).

**Production wiring — the "wired not just defined" trap:** `packages/module-registry/src/index.ts:1840`
currently does `peopleNotesService: new PeopleNotesService()` with no `boss`. **Must change to pass
`boss: deps.boss`** (that dep is already available in that scope — `deps.boss` is passed to
`registerPeopleRoutes` two lines above at line 1838) or nudges silently never fire in prod. This is
exactly the kind of gap `coordinated-build`'s review trap warns about — don't miss it.

### 6. NEW `packages/structured-state/src/vault-ingest-provider.ts`
```ts
export function createStructuredStateVaultIngestRootProvider(repo = new EntitiesRepository()): VaultIngestRootProvider {
  return {
    moduleId: "structured-state",
    async resolveRoots(scopedDb, _ownerUserId) {
      const entities = await repo.listVisible(scopedDb); // RLS already scopes to owner
      return entities.filter((e) => e.vault_note_path).map((e) => e.vault_note_path as string);
    }
  };
}
```
Confirmed dormant (no entity has `vault_note_path` set in prod — matches plan). Export from
`packages/structured-state/src/index.ts`. Add `"@moss/memory": "workspace:*"` dep.

### 7. Wire providers + sweep/tick/nudge workers at boot — `packages/module-registry/src/index.ts`
- **memory module descriptor** (currently line ~1533-1547, `queueDefinitions: []`, no
  `registerWorkers`): add `queueDefinitions: VAULT_INGEST_QUEUE_DEFINITIONS` and
  `registerWorkers: (boss, deps) => registerVaultIngestWorkers(boss, { vaultRunner: new VaultContextRunner(getVaultBaseDir()), vaultsBaseDir: getVaultBaseDir(), embeddingProviderFactory: createRuntimeEmbeddingProvider, repository: new MemoryRepository() })`
  — `VaultContextRunner`, `getVaultBaseDir`, `createRuntimeEmbeddingProvider` are already imported
  in this file (used by chat/people descriptors nearby).
- **people module descriptor** (line ~1830-1849): call
  `registerVaultIngestRootProvider(createPeopleVaultIngestRootProvider())` once at boot — inside
  `registerRoutes` or `registerWorkers`, either is called once at server start. Also fix
  `peopleNotesService: new PeopleNotesService({ boss: deps.boss })` at line ~1840 (see Task 5).
- **structured-state module descriptor** (line ~1587-1591, currently only `{manifest,
  sqlMigrationDirectories, queueDefinitions: []}`, no hooks at all): add
  `registerWorkers: async () => { registerVaultIngestRootProvider(createStructuredStateVaultIngestRootProvider()); return []; }`
  — **verify first** that a module with neither `registerRoutes` nor `registerWorkers` today is
  handled as "both optional, skipped if undefined" (near-certain given the type at line 610-612
  marks them optional, but confirm before assuming).

### 8. Grep-cite for the PR (Task 3 also needs this): after wiring, `grep -n
"registerVaultIngestWorkers\|registerVaultIngestRootProvider" packages/module-registry/src/index.ts`
— that's your "wired not just defined" proof citation.

## Task 2 test cases (6, per plan lines 100-108) — call `runVaultIngestSweep` / nudge logic
directly against a gate DB, not through live pg-boss polling:
1. allowlisted write → sweep produces `source_kind='vault'` chunks, right owner.
2. second sweep on unchanged vault → 0 new (hash-skip, check stats).
3. delete-then-sweep → chunks + file-index row gone.
4. one file throws during embed/ingest → only that file fails, present in `stats.failed`, others
   still ingest (shared-txn regression guard — this is WHY per-file `withDataContext` calls matter).
5. cross-owner: owner B's sweep never touches owner A's rows (RLS-level assertion, two real actors).
6. nudged write retrievable without any sweep run (freshness bound) — call `scheduleVaultIngestNudge`
   + drain the nudge queue (or call the nudge handler logic directly) then assert via
   `MemoryRetriever.retrieve(..., "vault")`.

## Task 3 (after Task 2 committed)
Real gate DB integration test: create a people-note via `PeopleNotesService`, run the sweep
(`runVaultIngestSweep` or equivalent), assert retrievable via `MemoryRetriever.retrieve(..., "vault")`,
then delete/archive and assert purge. Cite the module-registry registration call site (step 8 above)
in the PR body.

## Known non-blocking issue (carry forward, check at wrap-up)
`pnpm --filter @moss/memory typecheck` fails with TS6059 rootDir errors — confirmed pre-existing
(reproduced on a clean stash before any of this work). Not yet confirmed whether full `pnpm
verify:foundation` (root tsconfig) also hits this — **check at wrap-up**, report as a real finding
if it does.

## After Tasks 2 & 3 (unchanged from prior handoff)
1. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
2. `coordinated-wrap-up`: isolated gate-DB run via `verify-gate` skill, push, open PR (sensitive
   tier), confirm live-path gate applicability (Phase 1 = "no surfacing" — likely exempt, confirm
   against the plan's own per-phase exit criteria).
3. Report PR + verified evidence to Coordinator. **STOP — do not start Phase 2.**

## Run-specific bans (unchanged)
- Never touch `docs/coordination/` on this branch.
- `git add` scoped to explicit task files only — never `-A`/`.`.
- Never assume a migration number (none needed — `source_kind` CHECK already includes `'vault'`).
