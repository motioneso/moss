# Backtrack Phase 2 build plan: storing day memory in Moss

Spec: `docs/superpowers/specs/2026-09-23-trail-marker-screen-history.md` (approved by Ben,
2026-09-23; screens D and E in `docs/superpowers/specs/mockups/backtrack.html`). Part of #2638.
Phase 1 passed its kill gate on 2026-10-03 (#2638, #2860). This plan details Phase 2 from
`2026-09-23-backtrack.md` §1 and §6; where it differs from §6, §3 below says why.

Citations are against `origin/main` at `350669936`. Mac paths are under
`apps/trail-marker/TrailMarker/` unless given in full.

## 1. What Phase 2 ships

| Part | Ships                                                                                                                                                                        | Who sees it                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 2a   | Server: `backtrack` module, table, RLS, ingest route, index job, hourly retention purge, user routes (status, pause, delete), the Moss Settings → Backtrack screen, app map. | Nobody until the instance switch is on |
| 2b   | Mac: uploader, encrypted offline buffer, consent version 2, Backtrack in Release builds, "last sent" status. Shown only when the server says storage is on.                  | Nobody until the instance switch is on |

2a merges first; 2b depends on the 2a contract. Each part is its own PR with its own live proof.
Phases 3 (chat tool) and 4 (30-day summary) are planned after Phase 2's checkpoint (§9). The
instance switch stays **off on production until Phase 4 ships**. Ben's dev instance turns it on
for the live proof and the checkpoint.

## 2. Seams check

Proven present:

- **Companion routes.** Focus routes in `apps/api/src/companion-routes.ts:273-361`;
  `requireCompanion` (`:126-139`) resolves a `CompanionContext { actorUserId, deviceId, requestId }`
  (`packages/auth/src/companion-devices.ts:29-33`). Owner from the credential only (`:280-282`).
  `ipRateLimit(max)` at `:62-70`. Bodies are validated by Fastify JSON schemas with
  `additionalProperties: false` (e.g. `packages/shared/src/companion-api.ts:451`).
  `CompanionRouteDeps` (`:82-86`) has no `boss`; `server.ts:230` has one to pass in at `:385`.
- **Route guard.** Platform routes skip the module enablement guard through
  `PLATFORM_UNGUARDED_ROUTES` (`packages/module-registry/src/route-guard.ts:49-69`), checked by
  `assertRouteCoverage` (`:221`).
- **Heartbeat.** `CompanionHeartbeatResponse` (`packages/shared/src/companion-api.ts:87-92`), route
  at `companion-routes.ts:238`. The Mac reads `device.id` from it (`Services/CompanionClient.swift:64-69`).
- **Server redaction.** `redactSecrets` exported from `@moss/ai` (`packages/ai/src/index.ts:50`,
  `adapters/redact.ts:32`), already imported by other packages.
- **Module shape.** `BuiltInModuleRegistration { manifest, sqlMigrationDirectories, queueDefinitions,
registerRoutes?, registerWorkers? }` (`packages/module-registry/src/index.ts:813-825`), listed in
  `BUILT_IN_MODULES` (`:1666`). Manifest types in `packages/module-sdk/src/index.ts`
  (`MossModuleManifest` `:656-707`, `settings` `:534`, `dataLifecycle` `:778`). Sports is the
  metadata example (`features` `:126`, `settings` `:204-216`, `exportSections` `:626-633`);
  commitments is the routes-and-jobs example (`index.ts:2814-2890`).
- **Migrations.** Highest is `0257` (`infra/postgres/migrations/0257_focus_judgments_retention.sql`).
  The runner collects module directories from registrations (`scripts/migrate.ts:38-56`,
  `index.ts:3283`) and rejects duplicate versions (`packages/db/src/migrations/sql-runner.ts:163`).
- **RLS and roles.** `app.current_actor_user_id()` (`infra/postgres/migrations/0002_app_rls.sql:1`);
  `jarvis_worker_runtime` is `NOINHERIT NOBYPASSRLS` (`infra/postgres/bootstrap/0000_roles.sql:51-57`);
  worker read grant pattern in `packages/ai/sql/0037_ai_worker_read_grants.sql`.
- **Jobs.** `ALLOWED_PAYLOAD_KEYS` (`packages/jobs/src/pg-boss.ts:100-168`, top-level keys only),
  `sendJob` (`:187`), `registerDataContextWorker` (`:391`). Cron is declared in `registerWorkers`
  with `boss.schedule` (example `packages/focus-judgment/src/jobs.ts:24-29`), run only by the worker
  (`apps/worker/src/worker.ts:113`).
- **Memory.** `app.memory_chunks` (`packages/memory/sql/0030_memory_index.sql:4`), source-kind CHECK
  `('vault','connector','chat','notes')` (`packages/memory/sql/0106_memory_notes_source_kind.sql:5-8`).
  Public API: `MemoryRepository.upsertFileChunks` / `deleteFileChunks` (`packages/memory/src/repository.ts:66,95`),
  `embedChunks`, `parseDocument`, `createEmbeddingProvider` (`packages/memory/src/index.ts:1,18,73`).
  Chat's single-chunk indexing is the pattern to follow (`packages/chat/src/jobs.ts:120-150`).
  Worker chunk policies exist (`packages/memory/sql/0054_worker_memory_rls.sql:11-17`).
- **Recall never reads `screen` by accident.** Every chunk search names one source kind
  (`repository.ts:151,193,350`), and the retriever defaults to `"vault"`
  (`packages/memory/src/retrieval.ts:16,30`; `built-in-module-helpers.ts:30`). Chat recall asks for
  `"chat"` (`packages/chat/src/recall-port.ts:76`). So `screen` chunks are reachable only by a caller
  that asks for them, which is Phase 3's tool.
- **Instance switch.** `RUNTIME_CONFIG_REGISTRY` enum entries with an environment fallback
  (`packages/settings/src/runtime-config-keys.ts:92-104`), read through `RuntimeConfigResolver`
  (`runtime-config-resolver.ts:26`).
- **Data context.** `withDataContext` (`packages/db/src/data-context.ts:54`), the `DataContextDb`
  brand (`:29-34`).
- **Web settings.** Module settings entries are discovered from `manifest.settings.entry`
  (`packages/settings-ui/src/scanner.ts:57-131`) and rendered by `ModuleSettingsRouter`
  (`packages/settings-ui/src/router.tsx:38`); calendar is the example
  (`packages/calendar/src/manifest.ts:117-127`, `packages/calendar/src/settings/index.tsx:14-48`).
  Primitives: `Dialog` (`packages/ui/src/dialog.tsx:14`), `Button` `danger` (`button.tsx:3-8`),
  `Switch` (`switch.tsx:8`), `EmptyState` (`empty-state.tsx:10`), settings `Group`/`Row`/`Badge`
  (`packages/settings-ui/src/index.tsx:50-255`). A linked Mac shows up as a session with
  `source: "companion"` (`packages/shared/src/me-api.ts:28`).
- **App map.** Trail Marker text at `packages/shared/src/app-map-core.ts:99-100` (`:100` says
  Backtrack "does not yet store history in Moss"); descriptions capped at 240 characters
  (`packages/module-registry/src/index.ts:2956-2972`); module path rule in
  `tests/unit/app-map-integrity.test.ts:57`.
- **Tests.** Mocked web e2e in `tests/e2e` (`mockApi`, `tests/e2e/mock-api.ts:173`; module list in
  `tests/e2e/mock-modules.ts:10,163`). Real-stack UAT in `tests/uat/specs/*.uat.spec.ts` with seed
  chunks (`tests/uat/seed/types.ts:7`).
- **Mac.** `CompanionClient` (`Services/CompanionClient.swift:197`, bearer auth `:302-321`, errors
  `:144-158`, `:351-373`, no retries). `BacktrackSink` (`Backtrack/BacktrackSink.swift:9-18`) with one
  implementation, `BacktrackDebugRing` (`:23-40`). The source check's `ALLOWED` list
  (`apps/trail-marker/scripts/check-backtrack-sources.sh:18-20`) already names
  `"BacktrackUploader.swift:CompanionClient"` as its example. Consent version
  (`Services/PreferencesStore.swift:153-156`, `Backtrack/BacktrackRuntime.swift:100`). Keychain
  item pattern (`Services/KeychainStore.swift:66-107`). Device id (`Model/LinkAttempt.swift:7-12`).
  Log out and revoke reach `BacktrackRuntime.resetForEndedLink` (`:302-310`). The sanitiser already
  ports `redactSecrets`, Luhn card numbers and one-time codes (`Backtrack/BacktrackSanitizer.swift:78-137`).

Proven absent, so net-new: a `screen` source kind; a cross-owner chunk purge; any per-user or
runtime feature flag (manifest `featureFlags` are static and unchecked,
`packages/module-registry/src/index.ts:3465-3472`); `segmentIds` in `ALLOWED_PAYLOAD_KEYS`; a
delete-by-time-range UI anywhere; a checkbox primitive; on-disk storage or CryptoKit in the Mac app.

Debug gates 2b must lift: `App/AppDelegate.swift:19-29, 51-53, 76-80, 143-154`;
`Views/Settings/SettingsWindow.swift:7-10, 21-23, 38-41, 63-73`; the `#if DEBUG` wrapper rule in
`check-backtrack-sources.sh:45-46` and its self-test (`:82`). The Show text window
(`AppDelegate.swift:183-203`) and `BacktrackDebugRing` stay Debug-only.

Open questions, each with an owner:

- **Q6, answered by review round 1:** the local embedder caps input at 512 tokens, and a segment
  can hold 8 KB. So the index job splits `windowTitle + address + body` into chunks that fit 512
  tokens, and every chunk gets the segment's `sourcePath`. The builder reuses memory's own
  chunking if it can be bounded by tokens, and otherwise writes a token-bounded splitter in the
  backtrack package.
- **Q7 (2b builder):** whether the heartbeat runs often enough (`Model/ConnectionMachine.swift`) to
  carry the storage and pause state, or whether the upload response alone must carry it. The upload
  response carries it either way (§5.2).

## 3. Decisions (and what each rejected)

1. **The flag is an instance switch, `backtrack.storage` (`off` | `on`), in `RUNTIME_CONFIG_REGISTRY`,**
   default `off`, environment `MOSS_BACKTRACK_STORAGE`, admin-set. With it off, ingest refuses, the
   Mac hides Backtrack (Release) and the Moss screen says it isn't available. The purge runs anyway.
   _Rejected: a manifest feature flag_, because nothing checks one at request time. _Rejected:
   per-user enablement (`packages/settings/sql/0065`)_, because disabling the module would also
   hide delete, and a person must always be able to delete. Decision 12 makes the module
   impossible to disable for the same reason.
2. **Retention runs per owner, inside the owner's data context, not as one `SECURITY DEFINER` delete.**
   The newest precedent (`0257:15-46`, after `packages/ai/sql/0245`) gives the worker `EXECUTE` on a
   definer function and no `DELETE`. Steelman: one statement, atomic, no row access for the worker.
   It doesn't fit here, because the purge must also remove the segment's embeddings, which live in
   memory's table, and a backtrack-owned definer function touching `app.memory_chunks` breaks module
   isolation. So: a definer function returns only the **owner ids** that have expired segments
   (metadata, no content); the worker then opens each owner's data context and deletes segments and
   their chunks in one transaction through memory's public API. The worker gets `DELETE` on
   segments, limited by the same owner-only policy. The definer is owned by
   `jarvis_migration_owner`, which doesn't bypass forced row security, so, as in `0257:11-28`, it
   gets a `SELECT` policy of its own whose condition is the same expired-or-stale rule. That way it
   sees only rows needing upkeep, and no runtime role gains a cross-owner read (review round 1,
   S1).
3. **Segments and their embeddings are deleted in one transaction, serialised per owner.** Index,
   purge and user delete each take `pg_advisory_xact_lock(hashtextextended('backtrack:' || owner, 0))`
   first. Delete order is segments (`RETURNING id`), then their chunks. The index job re-reads the
   segment under that lock and does nothing if it is gone or past the cutoff. This closes the race
   the old plan named (a queued index job recreating a purged embedding) without row locks, which
   would need an `UPDATE` grant.
4. **A revoked Mac's rows stay.** `device_id` has no foreign key, as with `focus_judgments`
   (`0240:10-13`), because `app.companion_devices` is readable only by the auth role
   (`0238_companion_devices.sql:61`) and revoking hard-deletes the row (`companion-devices.ts:168`).
   _Rejected: cascade on revoke._ It would need a cross-role path, and deleting history is already
   an explicit action in Settings (§4 of the spec: revoke stops capture; the Mac discards unsent
   data).
5. **Unindexed segments are swept, not lost.** If the index job can't be enqueued after insert, the
   route still answers success (the rows are stored). A nullable `indexed_at` column marks indexed
   rows; the hourly job re-enqueues segments unindexed after 10 minutes. The worker gets column
   `UPDATE (indexed_at)` only. _Rejected: answering 503 so the Mac retries_, because a retried
   batch inserts nothing new (idempotent key) and so would enqueue nothing.
6. **Moss's pause switch is a per-user row,** `app.backtrack_preferences`. Ingest refuses while
   paused (the Mac discards, as for a local pause), and the Mac learns it from the upload response
   and the heartbeat.
7. **Delete ranges are explicit instants from the browser.** "Last hour", "Today" and "Choose a
   day" are computed in the person's time zone on the client and sent as `[from, to)`. The server
   doesn't resolve "today". "Everything" sends no range.
8. **Phase 2 ships no notes-folder row and no "also delete daily notes" box.** No notes exist until
   Phase 4; showing either would describe something that isn't there. Phase 4 adds both.
9. **Search stays out of Phase 2.** The generated `tsvector` and the `screen` embeddings are built
   now, so Phase 3 starts with data. Nothing reads them until Phase 3's tool.
10. **A deletion covers what was captured before it, and stays deleted (review rounds 1 and 2).**
    - **Server time everywhere.** Every upload carries `sentAt`, the Mac's clock when the request
      left. The server computes `skew = received_at - sentAt` and stores `started_at` and
      `ended_at` shifted by it, so they are in server time. A Mac's clock error then can't move
      a segment across a deletion boundary. The raw client start is kept only as
      `client_started_at`, for the idempotency key, because a retry's skew differs by network
      latency (decision 11 bounds the skew).
    - **Markers end at the moment of deletion.** A delete of `[from, to)` at server time `D`
      writes the marker `[from, least(to, D))`. "Everything" writes `(-infinity, D)`. So
      deleting "Today" at 10:00 covers midnight to 10:00, not the rest of the day, and new
      captures keep arriving while Recording is on (round 2, spec 1).
    - **One predicate, in two places.** Delete removes, and ingest refuses, exactly the segments
      whose server-time `[started_at, ended_at]` overlaps a marker. Ingest runs under the same
      owner lock as delete and counts refused segments as `discarded`.
    - **What this guarantees:**
      - a lost-response retry after a delete can't bring text back, whatever the Mac's clock;
      - neither can an offline second Mac uploading later;
      - this includes round 2's fast-clock case, where the retry's server-time interval falls
        before `D`.
    - **Marker lifetime.** Markers are kept 38 days, longer than any segment ingest still accepts.
    - _Rejected: relying on the unique key_, because the delete removes the key that made a retry
      idempotent. _Rejected: widening "Everything" by the allowed skew_, because it would discard
      genuine new captures (round 2, spec 2).
11. **Ingest bounds client time, and retention also counts from receipt (review rounds 1 and 2).**
    - **Skew.** A request whose `|skew|` exceeds one hour is refused with 422 `backtrack_clock`. The
      Mac shows "This Mac's clock looks wrong" and keeps the batch.
    - **Window.** After shifting, a segment is accepted only when `started_at` is no more than 26
      hours old (the 24-hour buffer plus slack) and `ended_at` is not after the time it was
      received. Anything else is dropped and counted as `rejectedClock`.
    - **Purge.** The purge removes rows past 37 days by `started_at` **or** by `created_at`.
    - **Wording.** The promise is "37 days, plus up to one hourly run", stated in exactly those words
      wherever it appears (consent, app map, settings).
12. **The module can't be disabled (review round 1, spec 3).** `lifecycle: "required"` and
    `availability: { defaultEnabled: true, required: true, supportsUserDisable: false,
supportsWorkspaceDisable: false }`, as calendar is (`packages/calendar/src/manifest.ts:87`). Its
    status, pause and delete routes are therefore always reachable. Recording is controlled only by
    the instance switch, the person's pause and the Mac's own consent and switches. _Rejected:
    session-authenticated cleanup routes outside the module guard._ That would split one module's
    routes across two guard regimes. And a disabled module that still accepts uploads (ingest is a
    platform route) would be worse than one that can't be disabled.
13. **Upload batches fit an explicit byte limit (review round 1, spec 4).** The route sets
    `bodyLimit: 2 MiB`. The uploader packs at most 200 segments **and** at most 1.5 MiB of encoded
    JSON per request, measuring the encoded bytes rather than estimating them. Two kinds of
    response are permanent: a 413 or a schema 400 for a batch. The uploader halves that batch and
    retries; a single segment that still fails is dropped from the buffer and counted, so one bad
    segment can't block the backlog.

## 4. Phase 2a: server

### 4.1 Memory (memory-owned, one PR task)

- Migration `packages/memory/sql/<next>_memory_screen_source_kind.sql`: widen the CHECK to
  `('vault','connector','chat','notes','screen')`.
- `MemoryRepository.deleteChunksForSources(scopedDb: DataContextDb, ownerUserId: string, sourcePaths: readonly string[], sourceKind: string): Promise<number>`,
  one statement, at most 500 paths a call. Backtrack uses this; it never queries `app.memory_chunks`.
- Tests: the old CHECK rejects `screen` and the new one accepts it; `deleteChunksForSources` removes
  only the named paths of the named kind for the actor, and nothing of another owner (run as both
  runtime roles).

### 4.2 Module, table, policies (`packages/backtrack/`)

Files: `package.json`, `src/manifest.ts`, `src/index.ts` (registration), `src/repository.ts`,
`src/routes.ts`, `src/jobs.ts`, `src/settings/index.tsx`, `sql/<next>_backtrack_segments.sql`.
Added to `BUILT_IN_MODULES` and `tests/e2e/mock-modules.ts`.

DDL (decision; the §6 provisional DDL plus `indexed_at` and the preferences table):

```sql
CREATE TABLE app.backtrack_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,                                          -- no FK: decision 4
  started_at timestamptz NOT NULL,                                  -- server time (decision 10)
  ended_at timestamptz NOT NULL,
  app_name text NOT NULL CHECK (octet_length(app_name) <= 400),
  bundle_id text NOT NULL CHECK (octet_length(bundle_id) <= 255),
  window_title text NOT NULL CHECK (octet_length(window_title) <= 1000),
  address text CHECK (octet_length(address) <= 2048),
  body text NOT NULL CHECK (octet_length(body) <= 8192),
  body_hash bytea NOT NULL CHECK (octet_length(body_hash) = 32),  -- SHA-256 of the redacted UTF-8 body, server-side
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', window_title || ' ' || coalesce(address,'') || ' ' || body)) STORED,
  indexed_at timestamptz,                                           -- decision 5
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at),
  client_started_at timestamptz NOT NULL,                           -- the Mac's raw start, for idempotency only
  UNIQUE (owner_user_id, device_id, body_hash, client_started_at)
);
CREATE INDEX backtrack_segments_owner_time ON app.backtrack_segments (owner_user_id, started_at DESC);
CREATE INDEX backtrack_segments_unindexed ON app.backtrack_segments (created_at) WHERE indexed_at IS NULL;
CREATE INDEX backtrack_segments_search ON app.backtrack_segments USING gin (search);
ALTER TABLE app.backtrack_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.backtrack_segments FORCE ROW LEVEL SECURITY;
-- Per-verb policies, owner_user_id = app.current_actor_user_id() AND that is NOT NULL:
--   SELECT, INSERT, DELETE for jarvis_app_runtime; SELECT, DELETE, UPDATE for jarvis_worker_runtime.
GRANT SELECT, INSERT, DELETE ON app.backtrack_segments TO jarvis_app_runtime;
GRANT SELECT, DELETE ON app.backtrack_segments TO jarvis_worker_runtime;
GRANT UPDATE (indexed_at) ON app.backtrack_segments TO jarvis_worker_runtime;

CREATE TABLE app.backtrack_preferences (
  owner_user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- ENABLE + FORCE RLS; owner-only SELECT, INSERT, UPDATE for jarvis_app_runtime; SELECT for jarvis_worker_runtime.

-- Deletion markers (decision 10). Owner-only; app runtime inserts and reads, worker reads and deletes.
CREATE TABLE app.backtrack_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  range tstzrange NOT NULL,                       -- '[from, least(to, deleted_at))', or '(,deleted_at)' for everything
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backtrack_deletions_owner ON app.backtrack_deletions (owner_user_id);  -- a person has few markers
-- ENABLE + FORCE RLS; owner-only SELECT, INSERT for jarvis_app_runtime; SELECT, DELETE for jarvis_worker_runtime.

-- Owner ids only, for the hourly job (decision 2). Fixed cutoffs, no arguments. Owned by
-- jarvis_migration_owner; it sees rows only through the bounded maintenance policies below.
CREATE POLICY backtrack_segments_upkeep_select ON app.backtrack_segments FOR SELECT TO jarvis_migration_owner
  USING (started_at < now() - interval '37 days' OR created_at < now() - interval '37 days'
         OR (indexed_at IS NULL AND created_at < now() - interval '10 minutes'));
CREATE POLICY backtrack_deletions_upkeep_select ON app.backtrack_deletions FOR SELECT TO jarvis_migration_owner
  USING (created_at < now() - interval '38 days');
CREATE FUNCTION app.backtrack_owners_needing_upkeep()
  RETURNS TABLE (owner_user_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app
  AS $$ SELECT owner_user_id FROM app.backtrack_segments
        WHERE started_at < now() - interval '37 days' OR created_at < now() - interval '37 days'
           OR (indexed_at IS NULL AND created_at < now() - interval '10 minutes')
        UNION
        SELECT owner_user_id FROM app.backtrack_deletions WHERE created_at < now() - interval '38 days' $$;
ALTER FUNCTION app.backtrack_owners_needing_upkeep() OWNER TO jarvis_migration_owner;
REVOKE ALL ON FUNCTION app.backtrack_owners_needing_upkeep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.backtrack_owners_needing_upkeep() TO jarvis_worker_runtime;
```

Manifest: `id: "backtrack"`; `lifecycle: "required"` and the non-disableable `availability` from
decision 12; `features` (Backtrack day memory, flag-off wording); `settings`
(`path: "/settings?section=modules&module=backtrack"`, `scope: "user"`, `entry: "./settings"`);
`dataLifecycle` with `deletion: { strategy: "cascade", tables: ["app.backtrack_segments", "app.backtrack_preferences", "app.backtrack_deletions"] }`
and an export section for segments (all columns but `search`, `body_hash` as hex). Queues:
`backtrack.index`, `backtrack.upkeep`.

Tests (each fails against the named broken build):

- A multibyte body of exactly 8192 bytes is accepted; 8193 bytes is rejected (fails if the check
  counts characters).
- `ended_at < started_at` is rejected.
- The same batch inserted twice stores one copy (fails without the unique key).
- Cross-owner `SELECT` and `DELETE` return nothing, as `jarvis_app_runtime` and as
  `jarvis_worker_runtime` (fails if a policy omits the actor check or a role).
- The worker can't `INSERT` or update any column except `indexed_at`.
- `backtrack_owners_needing_upkeep()`, called as the real `jarvis_worker_runtime` with **no actor
  set**, returns both owners when two owners each have a qualifying row (expired by `started_at`,
  expired by `created_at`, stale-unindexed, or an old marker), and nobody else. It fails without
  the maintenance policies, which is the S1 failure. Also as the worker with no actor: a plain
  `SELECT` on the table returns no rows.
- The module can't be disabled: the instance and user enablement resolvers both report it enabled,
  and status and delete answer while Backtrack storage is off.
- Account deletion removes the user's segments, preferences and `screen` chunks; export includes
  segments (the existing lifecycle tests, extended).

### 4.3 Instance switch

- `RUNTIME_CONFIG_REGISTRY` entry `backtrack.storage`: enum `off | on`, default `off`, env
  `MOSS_BACKTRACK_STORAGE`, `moduleOwner: "backtrack"`, with a description that says turning it on
  stores every opted-in person's screen text for up to 37 days.
- Not set in any compose or env file: the default is `off`, and nothing fails without it, so the
  "a PR must never break prod" rule needs no config change. Ben's dev instance sets it to `on`
  through Settings for the live proof.

### 4.4 Ingest route

- Contract in `packages/shared/src/companion-api.ts`:
  - `BacktrackSegmentUpload { startedAt: string; endedAt: string; appName: string; bundleId: string; windowTitle: string; address?: string; body: string }`
  - `BacktrackUploadRequest { sentAt: string; segments: readonly BacktrackSegmentUpload[] }`, 1 to 200 segments,
    `additionalProperties: false`, string `maxLength`s as character pre-checks.
  - `BacktrackUploadResponse { accepted: number; duplicates: number; discarded: number; rejectedClock: number; state: BacktrackState }`
    (`discarded`: overlaps a deletion marker, decision 10; `rejectedClock`: outside the time window,
    decision 11)
  - `BacktrackState = { storage: "off" | "on"; paused: boolean }`
  - `CompanionHeartbeatResponse` gains optional `backtrack?: BacktrackState` (optional so older Macs
    and servers keep working).
  - Error codes: `backtrack_unavailable` (409, switch off), `backtrack_paused` (409).
- Route `POST /api/companion/backtrack` in `apps/api/src/companion-routes.ts`, after the focus routes:
  `requireCompanion` → switch check → in the owner's data context, under the owner lock: pause
  check, skew and shift to server time, time window (decision 11), deletion markers (decision 10),
  `redactSecrets` on title,
  address and body, byte-length check, `body_hash`, insert with `ON CONFLICT DO NOTHING`
  `RETURNING id` → `sendJob(boss, "backtrack.index", { actorUserId, segmentIds })` after commit.
  Route `bodyLimit: 2 MiB` (decision 13; Fastify's default is 1 MiB). `ipRateLimit(10)` a minute.
  Added to `PLATFORM_UNGUARDED_ROUTES`. `boss` added to `CompanionRouteDeps`.
- The handler logs counts and the request id only.
- `segmentIds` added to `ALLOWED_PAYLOAD_KEYS`; the send site checks at most 200 entries, each a UUID.

Tests:

- The owner is the credential's, whatever the body says (fails if the body can set it; the schema
  has no owner field, and the test also sends one).
- A session cookie or module credential gets 401/403; a companion credential reaches nothing else
  (existing companion isolation tests, extended).
- Switch off → 409 `backtrack_unavailable`, nothing stored; paused → 409 `backtrack_paused`.
- A fake `sk-` key, `ghp_` token and a query string in title, address and body are stored redacted
  (fails with the server `redactSecrets` call removed; observed failing once).
- **No body text in logs or job payloads:** a request whose fields carry a marker string; the
  captured Fastify log and the enqueued payload never contain it, including for a schema-invalid
  request (observed failing with a deliberate `request.log.info(body)` added).
- 201 segments rejected; a 9 KB body rejected.
- A batch of 200 maximum-size segments, encoded to just under 2 MiB, is accepted. That one test
  fails at Fastify's default 1 MiB limit; round 1 reproduced a 1,669,014-byte batch getting
  `FST_ERR_CTP_BODY_TOO_LARGE`.
- **Lost-response retry:** a batch is stored, then deleted through "Today", then sent again
  unchanged with a new `sentAt`. Nothing is stored and no chunk is created; the batch is counted
  `discarded`.
- **Today at midday (round 2, spec 1):** with "Today" deleted at 10:00, a pre-delete segment
  arriving late from an offline Mac is discarded, and a segment captured at 10:10 is accepted.
- **Fast clock (round 2, spec 2, the exact sequence):** the Mac is 3 minutes fast. At server 09:59
  it uploads a segment stamped 10:02, and the response is lost. "Everything" is deleted at 10:00.
  The retry at 10:01 is discarded. A capture at 10:05 is accepted. The same pair runs with a
  3-minute-slow clock.
- **Late second Mac:** after "Everything", another device uploads segments captured before the
  delete; they are discarded. Its segments captured after the delete are accepted.
- A request with `sentAt` two hours off is refused with 422 `backtrack_clock`. A segment starting
  27 hours ago (after shifting) is counted `rejectedClock` and not stored.
- A retry of the same segment under a slightly different skew (latency) is a duplicate, not a
  second row. That case fails if the unique key uses the shifted `started_at`.

### 4.5 Index job

`registerDataContextWorker` for `backtrack.index`, payload `{ actorUserId, segmentIds }`. In the
owner's context, under the owner lock (decision 3): read the listed segments still present and
younger than 37 days; build `windowTitle + address + body` and split it to fit 512 tokens (Q6);
embed; upsert chunks with
`sourceKind: "screen"`, `sourcePath: "backtrack/<segment id>"`; set `indexed_at`.

Tests: indexes only the actor's rows; a segment deleted before the job runs gets no chunk; a
segment past the cutoff gets no chunk; a purge racing a queued index leaves no chunk (two
connections, lock ordering); passive recall (`retrieve` with no kind, and chat recall) never returns
a `screen` chunk even when it is the best match (fails if the default kind is widened).

### 4.6 Hourly upkeep job

`boss.schedule("backtrack.upkeep", "7 * * * *")` in `registerWorkers`. Calls
`app.backtrack_owners_needing_upkeep()`; for each owner, in their context under the lock: delete
segments with `started_at` **or** `created_at` older than 37 days `RETURNING id`, then
`deleteChunksForSources(..., "screen")` for those ids; delete deletion markers older than 38 days;
then enqueue `backtrack.index` for segments unindexed after 10 minutes (in batches of 200). It runs
whether or not the switch is on.

Tests: the 37-day boundary (36 d 23 h kept, 37 d 1 m removed), by `started_at` and separately by
`created_at` with a future `started_at` written directly; chunks go with their segments; another
owner's rows untouched; runs with the switch off; a stale unindexed segment is re-enqueued once;
a 38-day-old marker is removed and a younger one kept.

### 4.7 User routes (module routes, session auth; always reachable, decision 12)

In `packages/shared/src/backtrack-api.ts`:

- `GET /api/backtrack/status` → `{ storage: "off" | "on"; paused: boolean; macs: number; days: number; bytes: number; oldest?: string; lastReceivedAt?: string }`.
  `macs` is the count of distinct `device_id` with a segment in the last 30 days; the web screen
  uses sessions for "is any Mac linked".
- `PUT /api/backtrack/preferences` `{ paused: boolean }`.
- `DELETE /api/backtrack/segments` `{ from?: string; to?: string }` → `{ deleted: number }`.
  Both or neither; `from < to`; at most 31 days apart unless both absent (everything). Under the
  lock, it writes the deletion marker and then deletes segments and their chunks, in one
  transaction, like the purge.

Tests: delete removes rows and chunks in range only, for the actor only, and writes its marker; a
half range is rejected; pause stops ingest within one request; status counts only the actor's
rows; status and delete work with storage off.

### 4.8 Moss Settings → Backtrack (screens D and E, minus decision 8)

`packages/backtrack/src/settings/index.tsx`, built from `Group`, `Row`, `PaneHead`, `Note`,
`Switch`, `Badge` (settings-ui), `Button` (`secondary`, `danger`), `Dialog` and `EmptyState`
(`@moss/ui`). No new classes; the `design-system` skill's audit runs on it.

- **History or a linked Mac, switch on:** a "Recording" switch (the pause, across all Macs), a badge
  "On · N Mac(s)", "Days kept" and "Stored" rows, "Last received". Delete row: "Last hour",
  "Today", "Choose a day…" (native `type="date"`, as `tasks/task-details-dialog.tsx:415` does),
  danger "Everything…".
- **Everything…** opens `Dialog` E: "Delete all of Backtrack?", Cancel, danger "Delete everything".
- **No Mac linked but history stored** (for example, after revoking the only Mac; decision 4): the
  storage rows and the Delete row as above, with a `Note` that no Mac is linked. Deleting never
  needs a linked Mac (review round 1, spec 2).
- **No Mac linked and no history:** `EmptyState` pointing to Trail Marker for Mac.
- **Switch off on the instance:** a `Note` saying Backtrack storage isn't available on this Moss yet,
  plus the Delete row if any rows exist (from a time it was on).
- **Loading:** the settings skeleton used by other module panes; **error:** a `Note` with retry.
- Every message renders from the status record, never from model output (there is no model in
  Phase 2).

### 4.9 App map, release note, specs

- `app-map-core.ts:100`: Backtrack can store history in Moss when the instance allows it, where to
  delete it, that it's kept for 37 days, plus up to one hourly run, for now; trimmed to the
  240-character cap.
- Module manifest `features` and `settings` entries; `tests/unit/app-map-integrity.test.ts` passes.
- Release note: `Category: N/A` for 2a while the switch is off everywhere it ships (nothing
  user-visible changes). 2b likewise. The note that announces Backtrack comes with Phase 4, when the
  switch turns on.
- Spec §6 amended in the 2a PR: retention is 37 days, plus up to one hourly run, until Phase 4;
  revoke keeps rows; deletion by explicit range and permanent (markers); uploads bounded by time
  and size; no notes row before Phase 4.

## 5. Phase 2b: Mac

### 5.1 Contracts

- `final class BacktrackUploader: BacktrackSink` (`Backtrack/BacktrackUploader.swift`):
  `requiredConsentVersion = 2`; `accept` appends to the buffer; a 60 s timer sends the oldest
  segments, up to 200 **and** 1.5 MiB of encoded JSON (measured, decision 13), through
  `CompanionClient.backtrackUpload(credential:_:) async throws -> BacktrackUploadResponse`, with
  `sentAt` set from the Mac's clock on every attempt, never reused from an earlier one; on 422
  `backtrack_clock`, keeps the batch and shows the clock message;
  removes them from the buffer on 2xx (whatever the `discarded` and `rejectedClock` counts); keeps
  them on network errors; on 413 or a schema 400, halves the batch, and drops a single segment that
  still fails; drops them and stops on `backtrack_unavailable` or `backtrack_paused`; drops
  everything and stops on credential invalid. When `rejectedClock` is more than zero, the status
  line says the Mac's clock looks wrong. No send while Pause All, the Backtrack switch, lock or
  sleep is in effect.
- `struct BacktrackBuffer` (`Backtrack/BacktrackBuffer.swift`): AES-GCM (CryptoKit) with a 256-bit
  key in the Keychain (new item beside `storeVisionKey`, `KeychainStore.swift:66-107`), file in
  Application Support with `.completeUntilFirstUserAuthentication` protection, capped at 24 hours
  and 20 MB, oldest dropped first, wiped (file and key) on log out, revoke and Backtrack off.
- `BacktrackSegment` → upload mapping: `body` is `lines.joined("\n")` cut at 8192 UTF-8 bytes on a
  character boundary; `device_id` comes from the credential on the server, not the body.
- Consent: `BacktrackRuntime.consentVersion = 2`. The version-2 sheet (mockup C copy: what is read,
  that it's sent to Moss, kept for 37 days plus up to an hour for now, deletable in Moss). A stored version 1 shows
  the sheet again before anything is sent.
- `CompanionClient` gains `backtrackUpload`; `CompanionError` maps the two 409 codes.
- Settings → Backtrack: status line gains "Last sent …" and "Paused from Moss"; an "Open in Moss…"
  button to `/settings?section=modules&module=backtrack`. Shown in Release only when the last known
  `BacktrackState.storage` is `on`.
- Source check: `ALLOWED` gains `BacktrackUploader.swift:CompanionClient`,
  `BacktrackBuffer.swift:FileManager`, `BacktrackBuffer.swift:write(to:`,
  `BacktrackBuffer.swift:Data(contentsOf:`. The `#if DEBUG` rule moves to `BacktrackDebugRing.swift`
  and the Show text view only; the self-test plants the new failure.

### 5.2 Tests

- The spy-sink boundary tests run against `BacktrackUploader` with a fake transport: consent 1
  sends nothing; after log out nothing is sent and the buffer file and key are gone (fails with
  the wipe removed; observed failing).
- Pause All, the switch, lock: no request leaves (transport spy count 0).
- Offline: segments survive in the buffer and send in order when the fake transport recovers; the
  24 h and 20 MB caps drop oldest first.
- The buffer file contains no plaintext marker string (fails if written unencrypted).
- A 1,000-segment backlog of maximum-size segments goes out as several requests, none over 1.5 MiB
  encoded. A fake 413 halves the batch. A single segment that is always rejected is dropped, and
  the rest arrive.
- `backtrack_paused` stops sending and empties the buffer; `backtrack_unavailable` hides the tab in
  Release.
- Release build: contains `BacktrackUploader`, not `BacktrackDebugRing` (an `nm` check replaces the
  Phase 1 one).

## 6. Determinism boundary

No model runs in Phase 2. Embeddings come from the local embedder and aren't shown to anyone.
Every message on the Moss screen and the Mac status line renders from records (`status`,
`BacktrackState`, the buffer). Model jobs come in Phase 3 (search answers) and Phase 4 (summaries).

## 7. End-to-end tests

- **Mocked web e2e** (`tests/e2e/backtrack-settings.spec.ts`, CI): the four screen states; "Today"
  sends the browser's local-day range; Everything opens the dialog and sends no range.
- **Real stack UAT** (`tests/uat/specs/2638-backtrack-storage.uat.spec.ts`, level `admin+data`):
  seeds segments and `screen` chunks for two users, turns the switch on, deletes "Today" for one,
  and checks in the database that only that user's today rows and chunks are gone.
- **Mac UI test**: the Backtrack tab in a Release-configured run hides while storage is off.

## 8. Verification (from the repo root; never piped)

```bash
pnpm db:migrate > /tmp/bt-migrate.log 2>&1; echo "EXIT=$?"                     # 0, only through the verify-gate skill
pnpm verify:foundation > /tmp/bt-vf.log 2>&1; echo "EXIT=$?"                   # 0, only through the verify-gate skill
pnpm test:e2e -- tests/e2e/backtrack-settings.spec.ts > /tmp/bt-e2e.log 2>&1; echo "EXIT=$?"   # 0
pnpm test:uat -- tests/uat/specs/2638-backtrack-storage.uat.spec.ts > /tmp/bt-uat.log 2>&1; echo "EXIT=$?"   # 0
cd apps/trail-marker && xcodebuild test -scheme TrailMarker -destination 'platform=macOS' > /tmp/tm-test.log 2>&1; echo "EXIT=$?"   # 0
cd apps/trail-marker && xcodebuild -scheme TrailMarker -configuration Release -destination 'platform=macOS' -derivedDataPath /tmp/tm-rel build > /tmp/tm-rel.log 2>&1; echo "EXIT=$?"   # 0
bash apps/trail-marker/scripts/check-backtrack-sources.sh --self-test > /tmp/tm-src.log 2>&1; echo "EXIT=$?"   # 0
```

Live path on Ben's Mac against the dev instance with the switch on (spec §10 steps 1, 2, 3, 5 and
7; 4 and 6 belong to Phases 3 and 4), recorded on each PR:

1. A known Safari page and a Ghostty session reach the table within about two minutes; the stored
   address has no query string.
2. A Never-watch app, a private window and the password test page (`zebra-*` markers) store nothing;
   checked with SQL, not only in the UI.
3. A fake API key and a Luhn-valid test card number on screen are stored redacted.
4. Tailscale off for ten minutes, then on: the buffered segments arrive, none lost.
5. "Delete today" in Moss leaves no rows or `screen` chunks for today, and stays that way after
   the Mac reconnects from ten minutes offline.
   5a. Revoke the Mac in Moss: the Backtrack page still shows its history and "Everything" deletes it.
6. Moss's Recording switch off: the Mac shows "Paused from Moss" and sends nothing.
7. CPU over a working day stays within Phase 1's gate (≤3% mean), uploads included.

## 9. Checkpoint before Phase 3 (Ben decides)

After a week of Ben's real use on the dev instance with the switch on:

- storage stays under 5 MB on a heavy day (the spec's estimate);
- no unredacted secret or Never-watch text in the table (SQL sample of known markers and a random
  read of 50 segments by Ben);
- Ben, reading his own rows, says the stored text would answer his "what did I see" questions.

If any fails, the line stops or returns to design before Phase 3 is planned.

## 10. Review and rulings ledger

Round 1 (Codex, 2026-10-03, on `2373b14a6`). All six findings were checked against the code at
`350669936`. All six are **valid**, and each is folded into this revision.

| #   | Finding                                                                     | Ruling                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The upkeep definer sees nothing under forced RLS                            | **Valid.** `0257:11-28` adds `jarvis_migration_owner` maintenance policies for exactly this; `0257:11-13` says that owner doesn't bypass forced row security. → decision 2, bounded maintenance `SELECT` policies, a no-actor worker test with two owners. |
| 1   | A retry or a late upload can undo a delete                                  | **Valid.** The unique key goes when the row is deleted. → decision 10: deletion markers checked by ingest under the owner lock; lost-response and late-second-Mac tests.                                                                                   |
| 2   | No delete controls once the last Mac is revoked                             | **Valid.** Decision 4 keeps rows, so this is an ordinary state. → §4.8: the storage and delete rows show whenever history exists; live step 5a.                                                                                                            |
| 3   | Disabling the module blocks delete but not ingest                           | **Valid.** Module routes 404 when disabled; ingest is a platform route. → decision 12, a required, non-disableable module (calendar's pattern, `packages/calendar/src/manifest.ts:87`); tests with storage off.                                            |
| 4   | 200 × 8 KB exceeds Fastify's 1 MiB default                                  | **Valid**, and reproduced (1,669,014 bytes → `FST_ERR_CTP_BODY_TOO_LARGE`). → decision 13: route `bodyLimit` of 2 MiB, a 1.5 MiB encoded budget in the uploader, halving on 413/400, a poison segment dropped.                                             |
| 5   | Client clocks can stretch retention; "37 days at most" overstates the bound | **Valid.** → decision 11: a time window at ingest, a purge by `started_at` or `created_at`, and the wording "37 days, plus up to one hourly run".                                                                                                          |
| Q6  | The local embedder caps input at 512 tokens                                 | **Accepted as the answer to Q6.** → §4.5 splits each segment to fit.                                                                                                                                                                                       |

Round 2 (Codex, 2026-10-03, on `7ee3f1409`). It found no standards findings and rated S1 and spec
2–5 addressed. Spec 1 was partly addressed; the two remaining issues are both **valid**:

| #    | Finding                                                                        | Ruling                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2-1 | A "Today" marker runs to midnight, so it silently discards the rest of the day | **Valid.** → decision 10: markers end at the deletion instant (`least(to, D)`); the midday test checks that a late pre-delete segment is discarded and a 10:10 capture accepted.                                         |
| R2-2 | A fast Mac's lost-response retry slips past an "Everything" marker             | **Valid**, reproduced by the reviewer. → decision 10: segments are stored and compared in server time via `sentAt`; the idempotency key uses the raw client start; the exact sequence is a test, with a slow-clock twin. |
