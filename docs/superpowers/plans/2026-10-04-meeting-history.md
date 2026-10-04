# Meeting history metadata, search, and selection (#2981)

Status: implementation checkpoint; plan was committed before code. Isolated database and real-UI verification of this new slice remain pending publication.
Build: [#2981](https://github.com/motioneso/moss/issues/2981), [PR #2982](https://github.com/motioneso/moss/pull/2982).
Base inspected: `bee892ce`.
Approved design: `docs/superpowers/specs/2026-10-03-meeting-companion.md`, sections 4–5 and actual `2026-10-03-meeting-companion/Moss-meeting-04.png` pixels.

## Scope and truthful boundaries

Close the History metadata, server filtering/search, and selected-meeting rail gap in the existing
approved screen. This slice is read-only apart from maintaining an internal search projection in
the already-authorized draft/transcript write transactions. The existing `/api/meetings/records`
contract remains compatible. No native capture, credentials, audio, provider call, Tasks query,
vault I/O, permissions change, public sharing of meeting data, or deployment is part of this slice.

History derives every label from persisted meeting-owned records. The capture status is explicitly
`unavailable`; current data cannot prove recording state, capture completeness, capture mode,
paused intervals, or elapsed recording duration. Retained source labels are supplied transcript
metadata, not verified devices or speakers. A transcript span is the minimum current segment start
through the maximum current segment end, not continuous coverage or meeting duration. Accepted
suggestions are review receipts, not a count of still-existing Tasks. Vault states are the last
stored write/index acknowledgements, not a fresh check that a file exists or has been indexed.

Search covers current title, current personal notes, and the latest retained revision of every
transcript segment across all owner-visible meetings, before pagination. It excludes superseded
transcript text, historic note receipts, generated summary content, and independently copied Tasks
or vault files. Those exclusions describe the search surface, not deletion of retained history.

## Verified seams

- Draft identity, current notes, and descending `(created_at, id)` cursor: `packages/meetings/src/repository.ts:109–138`; table and owner/date index: `packages/meetings/sql/0260_meeting_records.sql:2–33`.
- Authenticated route registration enters `withDataContext`: `packages/meetings/src/routes.ts:21–41`; actor GUC is transaction-local: `packages/db/src/data-context.ts:65–87`.
- Transcript ingestion already validates/reconstructs the ledger and inserts its receipt in one actor transaction: `packages/meetings/src/transcript-repository.ts:102–143`. It caps each batch at 100 events/512 KiB, each segment at 100,000 UTF-16 characters, and the ledger at 20,000 revisions/32 MiB: `packages/meetings/src/transcript-batch.ts:10–12,55–67,119–142,178–180`.
- Current segment identity and finality are explicit; source kind is only microphone/output: `packages/shared/src/meeting-transcript-api.ts:2–31`. No persisted per-record capture mode exists in the inspected record schema.
- Active output head is highest non-inactive version; staleness compares current input revisions: `packages/meetings/src/output-repository.ts:114–127,163–179`. Generated request reservations have `expires_at` but no independent creation timestamp: `packages/meetings/sql/0265_meeting_outputs.sql:2–10`. Generation requests are distinguished by `input_json.kind`: `packages/meetings/src/output-service.ts:42`.
- Candidate review states and accepted-copy identity live in Meetings, with independent Task lifecycle: `packages/meetings/sql/0265_meeting_outputs.sql:24–39`.
- Export receipts distinguish write and indexing acknowledgement, and update under existing export transactions: `packages/shared/src/meeting-export-api.ts:7–32`; `packages/meetings/src/export-repository.ts:118–136`.
- Existing History filters only loaded full-note records: `packages/meetings/src/web/meeting-history.tsx:20–42`; this is the behavior replaced, not reused for server search.
- API defaults to Fastify request logging: `apps/api/src/server.ts:244–249`. Installed Fastify's `lib/logger-pino.js` request serializer includes URL, method and connection metadata, not body. The generic module route error helper logs the original error: `packages/module-sdk/src/route-errors.ts:122`. New history operations must scrub DB errors before this boundary; POST alone is not a complete logging claim.
- The real registrar/manifest coverage test exists: `tests/unit/meeting-manifest.test.ts:94–134`. Migration and cascade catalogs must change alongside new storage: `tests/integration/foundation-schema-catalog.test.ts:548–555`; `tests/integration/module-data-lifecycle-cascade.test.ts:154–162`.

## Public contract

New shared file: `packages/shared/src/meeting-history-api.ts`; export through the shared index.
The owner-authenticated routes use the module's existing `meetings.read` permission:

- `POST /api/meetings/history/search`, read-only query body, returns `MeetingHistoryPage`.
- `GET /api/meetings/history/:id`, returns `{ meeting: MeetingHistoryItem }`, or the same 404 for absent/inaccessible identity.

A separate GET collection is unnecessary; an empty POST body retrieves default History. Search
text never goes into request URLs, browser location, localStorage, error messages, or new logs.
The UI keeps it in signed-in session memory/query state only. Stable filter/selection IDs may be
URL state. Both routes use `Cache-Control: no-store`.

```ts
export type MeetingHistoryFilter =
  | "all"
  | "transcript"
  | "needs-review"
  | "exported"
  | "notes-only";

export interface SearchMeetingHistoryInput {
  readonly query?: string;
  readonly filter?: MeetingHistoryFilter;
  readonly limit?: number;
  readonly before?: MeetingRecordCursor;
}
export interface MeetingHistoryPage {
  readonly meetings: readonly MeetingHistoryItem[];
  readonly nextCursor: MeetingRecordCursor | null;
}
export interface MeetingHistoryItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hasNotes: boolean;
  readonly notesRevision: number;
  readonly capture: { readonly status: "unavailable" };
  readonly transcript: {
    readonly status: "none" | "retained";
    readonly revision: number;
    readonly segmentCount: number;
    readonly finalSegmentCount: number;
    readonly provisionalSegmentCount: number;
    readonly span: { readonly startMs: number; readonly endMs: number } | null;
    readonly sources: readonly { readonly kind: "microphone" | "output"; readonly label: string }[];
    readonly omittedSourceCount: number;
  };
  readonly summary: {
    readonly status: "none" | "available" | "stale";
    readonly version: number | null;
    readonly origin: "generated" | "manual" | null;
    readonly createdAt: string | null;
    readonly generation: {
      readonly status: "pending" | "failed" | "interrupted" | "saved";
      readonly expiresAt: string;
    } | null;
  };
  readonly actions: {
    readonly pending: number;
    readonly accepted: number;
    readonly dismissed: number;
  };
  readonly vault: {
    readonly latest: {
      readonly artifactVersion: number;
      readonly writeStatus: MeetingExportReceipt["writeStatus"];
      readonly indexStatus: MeetingExportReceipt["indexStatus"];
      readonly updatedAt: string;
    } | null;
    readonly savedVersionCount: number;
  };
}

export class MeetingHistoryRepository {
  search(db: DataContextDb, input?: SearchMeetingHistoryInput): Promise<MeetingHistoryPage>;
  get(db: DataContextDb, id: string): Promise<MeetingHistoryItem | null>;
}
```

Bounds: default 30/max 50 records; query at most 256 characters and 512 UTF-8 bytes, no NUL;
at most 16 normalized distinct search terms; cursor fields must be supplied together and use a
canonical UTC timestamp plus UUID. Reject additional body properties. Fetch `limit + 1` identities
to derive `nextCursor`; a client never guesses availability from an exactly full page. No total
count is promised. Each row has at most four distinct source-kind/label pairs (existing labels
are limited to 256 characters), with an explicit omitted count. No notes, transcript excerpts,
output bodies, model routes, Task IDs/titles, note paths, hashes, or request input/result JSON
are in this metadata contract.

### Search and filtering semantics

Normalize words using PostgreSQL's explicit `simple` text-search configuration. Matching is
case-insensitive whole-word matching, not substring, stemming, phrase, regex, or an advanced
query language. Every normalized term must appear somewhere in the same meeting's current
title/notes or current transcript segments. Terms may cross source/segment boundaries. Query
punctuation is ordinary text; a nonempty query with no searchable terms returns an empty page,
not all meetings. Whitespace-only input means no query. Excess normalized terms return a safe
validation error rather than truncating the query.

Apply cursor, query and filter in SQL before page selection. Filters are:

- `all`: all accessible records.
- `transcript`: one or more current retained segments, including provisional segments.
- `needs-review`: any pending action candidate, provisional segment, stale selected summary,
  latest failed/interrupted generation attempt, or latest vault write failure/conflict or delayed/conflicted indexing acknowledgement.
- `exported`: at least one saved write receipt, including an older version. UI label: “With a saved version.”
- `notes-only`: non-whitespace current notes and zero current transcript segments; this does not imply capture never happened.

Candidate counts include all retained versions, matching the current Review flow. Summary metadata
selects the active head, falling back to newest retained inactive output only when no active head
exists; inactive fallback is stale. Input-revision changes independently mark the selected head
stale. Latest generation is ordered by reservation expiry then request UUID; a null result before
expiry is pending, after expiry is interrupted without mutating the request. A stored interrupted
failure code remains interrupted. Old summary availability and a newer generation failure remain
separate facts. No creation time is invented from expiry. Latest vault receipt is ordered by its
stored canonical `updatedAt`, then artifact version; saved-version count is independent of that
latest outcome.

## Storage decision and migration 0267

Reserve `packages/meetings/sql/0267_meeting_history.sql` for this slice. Earlier migrations remain
unchanged. The unpublished native-authorization candidate must be renumbered before future use.
A migration is necessary: querying all append-only transcript JSON for every search would make
latency and memory grow with private historical revisions and cannot provide a useful index.

Use a current-segment projection, not a whole-meeting vector. It stores no extra raw text, only
private searchable lexemes and narrow segment metadata. PostgreSQL tokenization is per existing
bounded segment; no 32 MiB ledger is ever concatenated into a tsvector. Positionless lexeme arrays
also support indexed one-term matching without constructing user-authored tsquery syntax.

Chosen new table shape:

```sql
CREATE TABLE app.meeting_history_segments (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  segment_key TEXT NOT NULL, -- JSON.stringify(segmentId), preserving exact UTF-16 identity
  revision DOUBLE PRECISION NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991 AND revision = trunc(revision)),
  start_ms DOUBLE PRECISION NOT NULL
    CHECK (start_ms BETWEEN 0 AND 9007199254740991 AND start_ms = trunc(start_ms)),
  end_ms DOUBLE PRECISION NOT NULL
    CHECK (end_ms BETWEEN start_ms AND 9007199254740991 AND end_ms = trunc(end_ms)),
  finality TEXT NOT NULL CHECK (finality IN ('provisional', 'final')),
  search_terms TEXT[] NOT NULL,
  PRIMARY KEY (meeting_id, segment_key),
  FOREIGN KEY (meeting_id, owner_user_id)
    REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_history_segments_terms ON app.meeting_history_segments USING GIN (search_terms);
CREATE INDEX meeting_history_segments_owner ON app.meeting_history_segments (owner_user_id, meeting_id);
ALTER TABLE app.meeting_history_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_history_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_history_segments_owner ON app.meeting_history_segments
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT ON app.meeting_history_segments TO jarvis_app_runtime;
GRANT UPDATE (revision, start_ms, end_ms, finality, search_terms)
  ON app.meeting_history_segments TO jarvis_app_runtime;
```

`segment_key` stores the canonical JSON-string encoding of the validated segment ID, not the
UTF-8 encoding of its decoded JavaScript string. Distinct lone surrogate IDs remain distinct.
Revision and segment offsets preserve JavaScript-safe integer bounds without narrowing existing
valid inputs. Exactly one projection row covers each latest retained segment, including empty-text
or provisional segments; no subset or fixed-count cap substitutes for that coverage.

Add generated stored record `history_search_terms TEXT[]`, tokenized from current SQL title plus
notes, with a GIN index. A normal notes UPDATE therefore changes search atomically. These existing
SQL TEXT fields already follow PostgreSQL text encoding rules; no JSON decoding is involved.
Other projections use ordinary scalar columns maintained in their existing JavaScript write paths,
not generated expressions over whole TEXT JSON:

- Output requests: kind, result status and result code; partial latest-generation index on
  `(meeting_id, expires_at DESC, request_key DESC)` for kind `generate`. Update existing
  `pendingGeneration` kind/expiry lookups to use this scalar, removing its current whole-JSON casts. Maintain status/code
  in its direct expired-request bulk UPDATE as well as `reserve` and `finish`.
- Output artifacts: origin, input notes/transcript revisions and declared stale flag; active-head
  index `(meeting_id, version DESC) WHERE NOT inactive`.
- Export receipts: write/index status and canonical updated-time text; index by meeting/latest
  time/version. Update on each existing receipt write, in the same transaction.
- Transcript batches: bounded JSON-text encoding of the four distinct source-kind/label pairs,
  plus omitted-source count. JavaScript reads this small projection without PostgreSQL JSON
  extraction. Labels retain their original JSON representation, including lone surrogates.

Existing immutable `input_json`, `artifact_json`, `proposal_json`, and receipt/result bodies remain
byte-for-byte unchanged. Existing accepted validators are not tightened. PostgreSQL `jsonb` rejects
escaped NUL/unpaired surrogates, and `json` extraction also decodes Unicode while parsing; neither
is safe for these existing TEXT JSON contracts. References: `transcript-batch.ts:24–26,98–105,123–130`,
`output-validation.ts:84–86`, and the [PostgreSQL JSON compatibility documentation](https://www.postgresql.org/docs/current/datatype-json.html).

Only search normalization maps an unpaired UTF-16 surrogate to a word separator before database
tokenization; valid pairs and all ordinary text retain standard `simple` tokenizer semantics.
This derived search normalization does not edit evidence or identities. It is explicit and used
for both query text and segment search projections. NUL in previously valid output content has
no effect on scalar output metadata or search, which does not index generated output content.

Transcript ingestion deduplicates each accepted batch to the newest event per segment and upserts
current metadata/lexemes in the same existing transaction as its immutable receipt, only when the
segment revision increases. Exact retry and replay do not regress a head. The already-validated
ledger establishes correctness; this projection never becomes the authoritative evidence store.
Corrections replace old search words. Full meeting deletion cascades the projection. A rollback
rolls back both receipt and projection.

### Compatible, immutable application backfill

Add one self-contained, frozen first-party sidecar:
`packages/meetings/sql/0267_meeting_history.backfill.mjs`. The SQL file declares this exact adjacent
basename with `-- moss:backfill 0267_meeting_history.backfill.mjs`; missing declared bytes fail
closed on fresh install and drift inspection. Reject multiple declarations, traversal, absolute
paths, and noncanonical basenames; require the SQL basename with `.backfill.mjs` instead of `.sql`.
Read/hash exact UTF-8 bytes and reject invalid UTF-8 instead of replacement decoding. The sidecar exports `backfill(queryClient)` and
imports no current application helper or other source. Its JavaScript `JSON.parse` reads existing
TEXT JSON compatibly. A small generic extension in `packages/db/src/migrations/sql-runner.ts`
handles only explicitly declared first-party sidecars; the external module wire runner is unchanged.

- SQL-only migration checksums remain exactly SHA256(SQL bytes).
- The opted-in checksum is SHA256 of a versioned/domain-separated encoding of exact SQL bytes and
  exact sidecar bytes. `loadMigrationFiles` supplies this same checksum to application, pending and
  drift checks. Changing/removing the sidecar changes the applied checksum or fails loading.
- Merely loading/checking migration status never imports or executes the sidecar.
- After the existing advisory lock and `BEGIN`, execute SQL, then execute the already-hashed
  sidecar bytes via a data-URL import and pass only a bound query facade for the existing client.
  Await completion before ledger INSERT and COMMIT. No new database connection or background job. Execute these captured bytes, not a second file
  read, preventing a checksum/execution time-of-check/time-of-use mismatch.
- The source file is versioned and immutable once applied. Runtime projection helpers can evolve
  independently. The dedicated sidecar carries its own frozen normalization/projection logic.
- This is trusted first-party migration code, not a sandbox for untrusted callbacks. JavaScript
  globals remain available; the query facade reduces coupling, not execution privileges. No runtime
  HTTP surface, external-module permission, persistent credential, or worker privilege is added.

The migration follows existing transaction-local migration-owner `NO FORCE` backfill practice
(e.g. `packages/calendar/sql/0231_day_plan_reconcile_storage.sql`): temporarily permit the table
owner to backfill only the affected meeting tables, then restore FORCE before committing. Runtime
owner policies and role attributes do not broaden. A failure rolls back DDL, temporary RLS mode,
backfilled data and ledger together; retry starts cleanly. The sidecar must not leave a migration-
owner read policy or non-forced table behind. Integration tests assert final and rollback states.

Backfill one meeting at a time in descending UUID keyset batches and read each bounded transcript
batch in version order; retain at most that meeting's current heads (existing 20,000-revision and
32 MiB ledger limits). Select the highest accepted segment revision, preserving exact JSON-encoded
ID identity. Populate request/artifact/export scalar projections in separate bounded row pages, never all
1,000 possible 1 MiB artifacts for one meeting at once. Existing raw
payload bytes are never changed or printed. Invalid genuinely malformed historical JSON fails
with a fixed content-free migration error; previously valid NUL/lone-surrogate cases must succeed.

The canonical runner is already used by `scripts/migrate.ts` and
`tests/integration/test-database.ts`; explicit SQL-header opt-in therefore needs no duplicate
caller wiring. The migrate service runs source via `tsx` and deliberately is not bundled
(`scripts/build-app.ts:7–10`), so the checked-in adjacent sidecar ships with its module SQL.

### Query and privacy boundaries

Repository methods require `DataContextDb`; all accessed tables belong to Meetings. No runtime security-
definer function, role bypass, cross-module query, or additional credentials. Search normalizes
terms once, then intersects owner-scoped meeting IDs matched by each term in either the record
or current-segment GIN index. Aggregate only narrow segment/candidate metadata and latest scalar
request/artifact/export metadata; return a bounded page from one consistent SQL statement.

Indexes support candidates/date pagination, current segments, latest heads/requests/receipts and
term lookup. The runtime actor's actual query plan must be inspected in disposable CI: RLS can
change planner choices. Do not claim a particular GIN plan without observing it. Add an explicit
owner predicate as an optimization alongside, not instead of, forced RLS. Set a transaction-local
3-second statement timeout for History queries. Timeout returns a safe retryable history error;
never truncate records silently and report complete search.

Authentication errors retain existing 401/403 behavior. Repository/query failures are translated
to a fixed safe history error before entering `handleRouteError`, which otherwise logs raw errors.
The history route's schema-error handler returns fixed validation errors (no submitted values,
additional-property names, or parser detail). No query logging is added. Verify actual default
request/error logging with a marker in a successful query, invalid body and simulated DB error;
the negative control must expose the marker if raw error logging is restored. This claim is
limited to the inspected application logger, not arbitrary external infrastructure.

## Work packages and ownership

1. **Coordinator:** review and commit this plan before either code lane begins. Resolve any public
   contract changes first. Reserve migration 0267 and coordinate shared-file commits.
2. **Metadata/backend lane:** shared contract and schemas; `history-repository.ts`,
   `history-routes.ts`, current-segment projection helper; additive registration in `routes.ts`
   and `index.ts`; DB type declarations, migration, manifest route/feature/storage declarations,
   pure tests, isolated integration tests, migration/cascade catalog expectations, and the generic
   first-party sidecar loader/transaction tests in the canonical migration runner.
3. **History UI lane:** consume the contract via a dedicated history client; keep canonical
   `meetingKeys.history` prefix invalidation; replace client-only loaded-record filtering;
   selected metadata rail with independent fresh ID authorization, explicit Open review and
   existing Ask Moss. Preserve filter/selection and session search through review/back; do not
   leak old selected metadata/chat after denied access. Empty, loading, error, no-results,
   timeout/retry, narrow-screen, keyboard and theme states use existing design primitives.
4. **Coordinator:** aggregate scoped checks, final compiler/build checks, independent review,
   disposable CI integration and real UI UAT. Update PR evidence and app map in this same PR.

The model has no new job in this slice. Existing model jobs remain summary generation and scoped
meeting Q&A. All status, filter, selection and acknowledgement feedback derives from records;
no module-injected host chat turn and no new prompt guidance or model-authored persisted value.

## Verification and release gate

Pure/local checks only until the supported isolated DB gate is available. #2989 and its replacement
#2991 remain infrastructure proof dependencies; no improvised local server, database, or gate.
The metadata lane must not start a global compiler concurrently with the coordinator.

Expected exit 0 for each applicable unpiped command (use explicit touched paths when executing):

- `pnpm exec vitest run tests/unit/meeting-history-*.test.ts tests/unit/meeting-manifest.test.ts`
- `pnpm exec eslint <touched TypeScript files> --max-warnings=0`
- `pnpm exec prettier --check <touched files>`
- Coordinator: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, and app-map/feature-boundary audits.
- UI lane/coordinator: existing design-token/UI-class audits and the assembled web build.
- Disposable CI server: migration/schema/cascade and `tests/integration/meeting-history.test.ts`.
- Credential-free Meetings UAT group: real `tests/uat/specs/2981-meeting-history.uat.spec.ts`
  added to `tests/uat/run-meetings-uat.ts`, with the runner's environment contract unchanged.

Required behavioral tests and what breaks without them:

- Search a unique word in an older-than-first-page meeting; client-only filtering must fail.
- Terms split across title/notes/two transcript segments still match; chunk-local AND must fail.
- Correction removes old words and adds new ones; stale projection maintenance must fail.
- Same-batch multiple revisions, exact retry, concurrent accepted versions and transaction rollback
  preserve current metadata/search atomically; out-of-order upsert must fail.
- Existing and new transcript fixtures with distinct lone-surrogate IDs/labels/text, valid emoji
  pairs and literal backslash-u strings preserve exact identity/content through ingestion, backfill
  and correction. Output overview with NUL/lone surrogate remains saveable. Metadata/search still
  work; no full JSON cast or lossy identity conversion is allowed.
- SQL-only migration checksum stays unchanged; missing/modified declared sidecar fails closed;
  status inspection does not execute code; malformed/traversal/duplicate header or invalid UTF-8
  fails closed. External-module wire SQL must not gain sidecar execution. A thrown backfill rolls
  back DDL/data/RLS mode/ledger,
  retry completes once, and an applied replay skips sidecar execution.
- Punctuation/quotes/Unicode/NUL/oversized query/too many normalized terms/cursor pair validation,
  duplicate date tie-breaks, stable load-more and filter changes all have explicit outcomes.
- Large valid per-segment input and many segments remain ingestible/searchable without building
  one aggregate vector; metadata payload contains none of the long raw content.
- Owner A sees its matches; owner B and an admin without a grant see neither IDs, metadata nor
  direct projection rows. In the disposable server only, disabling the new table's RLS must make
  the direct-table negative-control assertion fail, then rollback restores protections.
- Backfill a pre-projection record with corrected transcript and notes, verify current matches,
  then delete the meeting and verify no projection survives. All actual module-owned tables and
  migrations remain declared and deletion-cascaded.
- Latest generation pending/expiry/failure and stale/manual/head output combinations do not turn
  capture into Recording/Stopped or imply a missing transcript is complete.
- Candidate counts survive independent Task changes; saved/index-delayed receipts and older saved
  versions remain distinguishable from the latest failed export, with no filesystem access.
- Route registration exercises the actual registrar and read permission, not a copied route list.
- A distinctive search marker never appears in captured default request/error logs or URL;
  negative control for raw-error logging is observed failing. Unknown error details are scrubbed.
- UI proof creates synthetic records through the real app/API, searches past the first page,
  filters, selects and opens Review/Ask Moss, returns via browser Back, loads older results,
  clears inaccessible selection, and exercises empty/error/keyboard/narrow/dark states. No response
  rewriting, fixtures masquerading as recording, screenshots, or real workplace content.

Phase-one kill gate: if the owner-scoped metadata/search API cannot remain within the bounded
payload/query budget, preserve old History and stop rollout. The coordinator decides whether to
reduce scope or revise the storage/query plan before a UI dependent release. Native capture stays
unavailable regardless of this slice's success. CI-green is not live-path proof: until real UI
assertions are recorded for the final commit, status remains code-complete, unverified.

## Rulings ledger

- Chosen: additive read contract plus normalized current-segment search. Rejected full JSON scan
  is simpler to write but repeats parsing 32 MiB ledgers, searches obsolete corrections, and
  cannot offer indexed all-record search. Rejected one whole-meeting vector can exceed PostgreSQL
  limits for already-valid transcripts. Per-segment data respects the existing bound.
- Chosen: POST query body; rejected GET query text would be copied into the default logged URL.
- Chosen: all-term matching across current meeting documents; passage-only matching would depend
  on arbitrary transcription chunk boundaries.
- Chosen: metadata GET by ID lets the rail reauthorize a selected older record independently of
  paging/filtering. Merely retaining a list row cannot prove current access.
- Chosen: latest vault receipt plus saved-version count. A saved older version does not make a
  failed current write successful or prove current filesystem state.

- Compatibility review: whole JSON casts would reject previously accepted escaped NUL/lone
  surrogates, including when extracting an unrelated scalar. Chosen ordinary write-time scalar
  metadata plus an immutable JS migration sidecar; rejected a bespoke SQL JSON/Unicode sanitizer
  and retroactively tightened validators. Authoritative evidence remains unchanged.

## Implementation checkpoint (2026-10-04)

The additive metadata/search routes, scalar/current-segment projection, frozen transactional
backfill and History table/selection rail are implemented in this tree. The existing records API
and authoritative JSON payloads remain the source contracts. Capture remains unavailable.

- Final focused local run: 503 tests passed across 35 Meetings/runner suites.
- Root/test/web and external-module type checks, full ESLint/Prettier, nine static audits,
  app-map generation and the web production build passed locally. The existing large-bundle
  warning remains.
- Observed negative controls: removing the migration callback scrubber exposes the synthetic
  private marker; removing History route error scrubbing also exposes its marker. Both protections
  were restored and their focused tests passed. These are pure synthetic checks, not DB proof.
- Independent review found and resolved incorrect framework 429 handling, denied-cache
  resurrection, auto-selected chat cleanup, missing-row focus recovery, mobile panel navigation,
  and offline queries being paused rather than sent. An in-memory test using the actual rate-limit
  plugin returned safe 429 plus Retry-After. Source/pure review does not establish browser focus.
- The new real-UI History test uses production APIs and genuine browser offline/reconnect state.
  It checks older-than-first-page and cross-document search, correction semantics, filters,
  selected review/back, deletion, viewport/theme contrast and keyboard navigation. It is added to
  the credential-free allowlist alongside the prior three Meetings specs.
- New isolated integration fixtures exercise owner/admin RLS, rollback/cascade, exact legacy JSON
  preservation, maximum accepted segment text/identity, same-millisecond cursor ties, receipt
  metadata and the natural runtime-RLS plan of the actual production query. Generic runner fixtures
  test DDL/data/FORCE/ledger rollback, concurrent retry and replay. These have not run locally.
- A broad local unit attempt during implementation finished with 10,814 passed, 70 failed and
  18 skipped tests (22 failed files, including suite setup failures). Failures include blocked
  sockets/network-interface inspection, absent Docker/browser/native PTY and tool-runtime setup;
  it is not an aggregate green result or final frozen-tree proof. Exact-commit hosted CI and the real History UAT must pass
  before this slice is called verified. Real capture/provider gates and the local DB hold remain.
