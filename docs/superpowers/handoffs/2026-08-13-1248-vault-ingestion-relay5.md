# 1248 vault-ingestion — relay 5 continuation (§3 research done, ZERO code written)

Spec: `docs/superpowers/specs/2026-08-12-1248-internal-vault-ingestion.md`
Plan: `docs/superpowers/plans/2026-08-12-1248-vault-ingestion.md` (Phase 1, lines 40-121)
**Primary build reference (still the target — read its numbered sections by task):**
`docs/superpowers/handoffs/2026-08-12-1248-vault-ingestion-relay2.md`
**All relay2 UNVERIFIED points already resolved — do not re-verify, just use:**
`docs/superpowers/handoffs/2026-08-12-1248-vault-ingestion-relay3.md`

Worktree/branch: this worktree, `1248-vault-ingestion`. Coordinator label: `Coordinator` (resolve
fresh via `herdr pane list` — session id is authority, not pane number).

**I relayed at the 74% context-meter warning having only re-confirmed relay2/3's already-resolved
signatures plus found ONE new gap below. No file writes, no commits this session. Go straight to
writing `packages/memory/src/vault-ingest-jobs.ts` — every signature you need is listed below or in
relay2 §3 / relay3. Do not re-read `packages/notes/src/jobs.ts` or the memory package files listed
below in full — trust this doc's summary and build.**

## NEW finding this session — fix as part of §3

`packages/jobs/src/pg-boss.ts`'s `ALLOWED_PAYLOAD_KEYS` (a `ReadonlySet<string>`, ~lines 77-114)
does **NOT** currently include `"op"`. Relay2 §3's `VaultIngestNudgePayload` design has a field
`readonly op: "upsert" | "delete"`. `assertMetadataOnlyPayload` (called internally by `sendJob`,
and required explicitly elsewhere per the Hard Invariant) will **throw** on any nudge payload
carrying `op` until this is fixed. Confirmed via `grep -n '"op"' packages/jobs/src/pg-boss.ts`
(no output) and `grep -rn "ALLOWED_PAYLOAD_KEYS" packages/` (only defined/used in `pg-boss.ts`).
**Fix:** add `"op"` to the `ALLOWED_PAYLOAD_KEYS` set in `packages/jobs/src/pg-boss.ts` as your
first small commit before/with §3 — it's an enum value, not content, consistent with the
invariant's intent (metadata-only payloads).

## Confirmed signatures — use directly, do not re-read source

- **`packages/notes/src/jobs.ts` pattern to mirror exactly**: `NOTES_QUEUE_DEFINITIONS: readonly
  QueueDefinition[]` with `{policy: "exclusive", retryLimit: 0, deleteAfterSeconds: 300,
  retentionSeconds: 300}`. `type EmbeddingProviderFactory = (scopedDb: DataContextDb) =>
  Promise<EmbeddingProvider>`. `handleNotesSyncJobWithDataContext(job, dataContextRunner,
  embeddingProviderFactory, preferencesRepository)` = **pure**, calls `toAccessContext(job)` once,
  then loops files each in its OWN `dataContextRunner.withDataContext(accessContext, cb)` call
  (never one shared transaction for a multi-file sweep). `registerNotesJobWorkers(boss,
  dataContext, options)` = the `boss.work<Payload,Result>(QUEUE, {pollingIntervalSeconds:2},
  async ([job]) => {...})` wrapper — builds `accessContext`, calls the pure handler, does a
  separate side-write, rethrows failures. **`runVaultIngestSweep` = pure/testable (per relay2 §3
  pseudocode), `registerVaultIngestWorkers` = the boss.work wrapper. Same split.**
- **`@moss/memory` (`packages/memory/src/index.ts`) already exports**: `MemoryRepository`,
  `MemoryIngestPipeline`, `EmbeddingProvider` (type), `IngestFailure`/`IngestStats`/`IngestOptions`
  (types, from `ingestion-service.js` — import `IngestFailure` directly, don't redefine),
  `VaultIngestRootProvider` (type), `registerVaultIngestRootProvider`,
  `listVaultIngestRootProviders`, `isPathIngestable`, `resolveIngestRoots`,
  `HARD_EXCLUDED_PREFIXES` (Task 1, already built — grep `index.ts` lines 18-25 for the exact
  block before adding new re-exports for `vault-ingest-jobs.ts`).
- **`MemoryIngestPipeline`** (`packages/memory/src/ingest.ts`): constructor
  `(embeddingProvider, repository)`. `ingestFile(scopedDb, vaultCtx, relativePath, options={})` →
  `IngestFileResult{status, chunkCount}` (derives `ownerUserId` from `vaultCtx.actorUserId`
  internally). `deleteFile(scopedDb, ownerUserId, sourcePath)`. **Do NOT use
  `pipeline.purgeDeletedFiles`** — purges against ALL `.md`, not the allowlist; write the custom
  purge loop from relay2 §3 using the already-computed allowlist-filtered file list.
- **`MemoryRepository.listIndexedPaths(scopedDb, ownerUserId, sourceKind)`**
  (`packages/memory/src/repository.ts:272-285`) → `Promise<string[]>` of `source_path`. Use
  directly as its own param to `runVaultIngestSweep`.
- **`VaultContextRunner.withVaultContext(accessContext, work)`** (`packages/vault/src/vault-context.ts`):
  validates `accessContext.actorUserId` non-empty, `mkdir`s the per-user vault root (mode 0700),
  invokes `work({[vaultContextBrand]:true, actorUserId, vaultRoot})`. Pass a plain
  `{actorUserId}` (requestId optional — `AccessContext{actorUserId: string; requestId?: string}`
  per `packages/db/src/data-context.ts:7-10`).
- **`listVaultOwnerIds`** (`packages/vault/src/vault-ops.ts`, already committed in `23b7b3cbc`):
  reads `vaultsBaseDir` dir entries, returns directory names as owner IDs, tolerates missing path.
  Exported from `packages/vault/src/index.ts`.
- **`packages/jobs/src/pg-boss.ts` exports**: `ActorScopedJobPayload{readonly actorUserId:
  string}`. `QueueDefinition{readonly name: string; readonly options?: Omit<Queue,"name">}`.
  `sendJob<T extends ActorScopedJobPayload>(boss, queue, payload, options?)` (line 137, applies
  `assertMetadataOnlyPayload` internally). `assertMetadataOnlyPayload(payload)` (line 120, throws
  if any key not in `ALLOWED_PAYLOAD_KEYS` — see NEW finding above). `toAccessContext(job)` (line
  339, validates `job.data.actorUserId` present+UUID, returns `{actorUserId, requestId:
  "pgboss:${job.id}"}`). `registerDataContextWorker(...)` exists but is explicitly NOT for the
  sweep handler (would serialize/deadlock across files in one shared transaction).
- **`boss.schedule` pattern**: `packages/notes/src/schedule.ts` uses a PER-ACTOR keyed schedule
  (`key: actorUserId`) — NOT the pattern for the vault-ingest tick. For the tick queue, call
  `boss.schedule(...)` **once**, with **no `key`** (single global schedule), inside
  `registerVaultIngestWorkers`.
- **Queue name constants**: per `packages/notes/src/manifest.ts` precedent (`NOTES_SYNC_QUEUE =
  "notes.sync"` as a plain top-level exported string const, not baked into a manifest object) —
  give `vault-ingest-jobs.ts`'s queue names the same shape.
- **Gate-DB integration test pattern** — use `tests/integration/notes.test.ts` as the direct
  template (864 lines, full pattern already proven in this repo). Key pieces:
  - `beforeAll`: `await resetEmptyFoundationDatabase()`; `appDb =
    createDatabase({connectionString: connectionStrings.app, maxConnections: 1})`.
  - Seed a user row via raw `pg.Client` against `connectionStrings.bootstrap`: `INSERT INTO
    app.users (id, email, is_instance_admin) VALUES ($1, $2, false) ON CONFLICT DO NOTHING`.
  - `makeJob(sourcePath)` helper builds a fake `Job<Payload>`:
    `{id: randomUUID(), data: {...}} as unknown as Job<Payload>`.
  - Call pure handlers directly: `dataContext.withDataContext({actorUserId, requestId}, scopedDb
    => handleXJob(...))` — no live pg-boss loop needed. **This is exactly how the 6 Task-2 test
    cases should call `runVaultIngestSweep`.**
  - Partial-failure pattern: subclass `StubEmbeddingProvider` (from `@moss/memory`) to inject a
    failure for content matching a string, assert partial ingestion + failed list — matches Task
    2 test case #4 (one file throws, others still ingest).
  - Cross-owner RLS pattern: two real seeded actors, assert owner B's sweep never touches owner
    A's rows — matches Task 2 test case #5.
- **Module descriptor current line numbers** (for §7, unchanged from relay3): memory
  `:1533-1547` (`queueDefinitions: []`, `registerRoutes` only); structured-state `:1587-1591`
  (bare, no hooks); people `:1830-1849` (`registerRoutes` builds `peopleNotesService: new
  PeopleNotesService()` at `:1840` with **no boss** — the gap §5 fixes; `registerWorkers` at
  `:1842-1848`; `deps.boss` already in scope, used at `:1838`). Both `registerRoutes?.()` and
  `registerWorkers?.() ?? Promise.resolve([])` are optional (`:2377`, `:2428`).
- **`createRuntimeEmbeddingProvider`** (`module-registry/src/index.ts:1447`): already matches
  `(scopedDb) => Promise<EmbeddingProvider>` directly — no wrapping needed. Call as
  `deps.embeddingProviderFactory(scopedDb)` inside a `withDataContext` callback.

## Not yet checked (do at build time, still open from relay3)

- Exact `PgBoss` type import path for `packages/people/src/notes-service.ts` — verify `@moss/jobs`
  is in `packages/people/package.json` deps (§4/§5), add if missing.
- `EntitiesRepository.listVisible` shape for the structured-state provider (§6) — unverified.

## Build order (unchanged from relay2/relay3, nothing done yet this session)

§3 (`vault-ingest-jobs.ts` + `ALLOWED_PAYLOAD_KEYS` fix, TDD against relay2's 6 test cases) → §4
(people provider) → §5 (notes-service nudge wiring + `PeopleNotesServiceDeps.boss` + fix
module-registry `:1840` prod wiring gap) → §6 (structured-state provider) → §7 (module-registry
wiring, all three descriptors) → §8 (grep-cite) → Task 3 e2e → pre-push trio
(`pnpm format:check && pnpm lint && pnpm typecheck`, then `git fetch origin main && git rebase
origin/main`) → `coordinated-wrap-up` (isolated gate-DB run via `verify-gate` skill, push, open PR
sensitive-tier, confirm Phase 1 = "no surfacing" → likely live-path-gate exempt, confirm against
plan's per-phase exit criteria, report to Coordinator, **STOP — do not start Phase 2**).

## Run-specific bans (unchanged)
- Never touch `docs/coordination/` on this branch.
- `git add` scoped to explicit task files only — never `-A`/`.`.
- Never assume a migration number (none needed — `source_kind` CHECK already includes `'vault'`).
