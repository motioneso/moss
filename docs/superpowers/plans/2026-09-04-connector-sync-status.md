# Build plan: Connected accounts sync status that explains itself

**Spec:** `docs/superpowers/specs/2026-09-04-connector-sync-status-design.md` (approved by Ben in chat, 2026-09-04)
**Task issue:** #2239
**Branch / PR:** one worktree, one PR for all slices (`feat/connector-sync-status`), off `origin/main`
**Written:** 2026-09-04, against the tree at the tip of PR 2240

This plan carries decisions, not implementations: paths, signatures, DDL, manifest shape, and
test cases stated as behaviour plus why they would fail against a broken build. Function bodies
are written against the compiler by the build agent.

## 0. Gates

- Approved spec: yes (Ben, chat, 2026-09-04, "specs approved, lets get those started").
- Task issue: #2239, open.
- No new module, so no mockup gate; the spec carries the row and Today sketches the pane is built
  from.

## 1. Seams check (every capability the plan leans on, cited from the tree)

| Capability                                                            | Where it is                                                                                                                                                                                          | Verdict                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync summary columns on the account row                               | `packages/connectors/sql/0099_connector_health_metadata.sql:2-11` adds `last_sync_started_at`, `last_sync_finished_at`, `last_sync_status` (check constraint), `last_sync_error`, `last_sync_counts` | exists                                                                                                                                                                                          |
| Writers of those columns                                              | `packages/connectors/src/repository.ts:223` `markSyncStarted`, `:245` `markSyncFinished(scopedDb, accountId, {finishedAt, status, error, counts})`                                                   | exists; both gain a `trigger` and the previous-run copy                                                                                                                                         |
| Owner-only reads and the admin-safe view                              | `repository.ts:116` `listAccounts`, `:122` `listAdminSafeAccounts`                                                                                                                                   | exists; admin view not widened                                                                                                                                                                  |
| Google sync job, queue names, continuation                            | `packages/connectors/src/sync-jobs.ts:31-33` (`connectors.google-sync`, continuation queue, 840 s expiry)                                                                                            | exists                                                                                                                                                                                          |
| IMAP sync job                                                         | `packages/connectors/src/imap-sync-jobs.ts:19` queue, `:60` `runImapSync`, `:162` worker registration                                                                                                | exists                                                                                                                                                                                          |
| Schedules, both every 15 minutes                                      | `google-schedule.ts:7` `GOOGLE_SYNC_CRON`, `:31` singleton key = actor; `imap-schedule.ts:7` `IMAP_SYNC_CRON`, `:32` singleton key = account id                                                      | exists; next-run helper is new                                                                                                                                                                  |
| Manual Google sync route and its dedupe                               | `packages/connectors/src/routes.ts:174-197` `POST /api/connectors/google/sync`, `sendJob` with `singletonKey: actorUserId`, null job id means deduped                                                | exists; kept for compatibility                                                                                                                                                                  |
| Metadata-only enqueue                                                 | `packages/jobs/src/pg-boss.ts:157` `sendJob` runs `assertMetadataOnlyPayload`                                                                                                                        | exists                                                                                                                                                                                          |
| Job state read with the root connection                               | `packages/jobs/src/pg-boss.ts:168` `hasInFlightJob(rootDb, queueName, actorUserId): Promise<boolean>`                                                                                                | exists but returns only a boolean. **The status route needs the newest job's state and creation time.** A sibling helper is added in the same file (see slice 2); this is the one platform gap. |
| Sync counts shape                                                     | `packages/shared/src/connectors-api.ts:12` `ConnectorSyncCounts`; producer `packages/connectors/src/google-sync-phases.ts:40-42`                                                                     | exists; **no counter for deferred AI extraction.** `:418` logs "google-sync email unit deferred for retry" but only `escalations` (`:383`) is counted. Slice 1 adds `emailDeferred`.            |
| Feature grants (which abilities an account feeds)                     | `packages/connectors/src/feature-grants.ts:16` `ConnectorFeature = "email" \| "calendar"`, `:73` `resolveEffectiveGrants`                                                                            | exists; the capability map keys off these two features                                                                                                                                          |
| Assistant tool declaration shape                                      | `packages/connectors/src/manifest.ts:200-215` (`assistantTools[]` with `name`, `description`, `permissionId`, `risk`, `inputSchema`, `outputSchema`, `execute(scopedDb, input, ctx)`)                | exists                                                                                                                                                                                          |
| Permission ids                                                        | `manifest.ts:91` `connectors.view`, `:98` `connectors.manage`, `:105` `connectors.admin`                                                                                                             | exists                                                                                                                                                                                          |
| Manifest `features` / `errors` / `remediations` precedent             | `packages/news/src/manifest.ts:490`, `packages/ai/src/manifest.ts:119`                                                                                                                               | exists                                                                                                                                                                                          |
| Route must be declared in the manifest or the server refuses to start | memory `route-must-be-declared-in-a-manifest`; connectors `manifest.ts:69-192` lists routes with `permissionId`                                                                                      | exists                                                                                                                                                                                          |
| Web pane and its in-flight refresh                                    | `apps/web/src/settings/settings-personal-data-panes.tsx:99` `AccountRow`, `:232` `ConnectedPane`, `:243-247` `refetchInterval` 2 s while `isConnectorSyncInFlight`                                   | exists. **There is no Sync now button in this pane today** (grep for `google/sync` in `apps/web/src` finds nothing). The button is net-new UI.                                                  |
| Current wording table                                                 | `apps/web/src/settings/settings-connector-sync.ts:3-20` (`ConnectorAccountHealth`, `isConnectorSyncInFlight`, `getConnectorAccountHealth`)                                                           | exists; becomes an adapter over the shared module                                                                                                                                               |
| A Today banner that reads freshness and warns                         | `apps/web/src/today/today-page.tsx:740` `BriefingStaleBanner`, defined in `apps/web/src/today/briefing-freshness.tsx:60`                                                                             | exists; the "Not working right now" block follows this pattern                                                                                                                                  |
| App map core entries                                                  | `packages/shared/src/app-map-core.ts:125-131` `connected`; the `today` entry in the same file                                                                                                        | exists                                                                                                                                                                                          |
| Migration numbering                                                   | highest across `packages/*/sql` and `infra/postgres/migrations` is `0213_sports_reddit_sources.sql`                                                                                                  | next is `0215`                                                                                                                                                                                  |
| Playwright e2e with a mocked API                                      | `tests/e2e/settings-modules.spec.ts:1-20` (`mockApi` with `connectorAccounts`), `tests/e2e/mock-connectors-api.ts`                                                                                   | exists                                                                                                                                                                                          |
| Live e2e against the dev instance                                     | `tests/live/`                                                                                                                                                                                        | exists                                                                                                                                                                                          |
| Test precedents                                                       | `tests/unit/connectors-feature-grants.test.ts`, `tests/unit/connectors-freshness.test.ts`, `tests/integration/connectors-imap-routes.test.ts`, `tests/integration/connectors-sync-wedge.test.ts`     | exists                                                                                                                                                                                          |

Open questions with owners:

- **Q1 (build agent, slice 2):** pg-boss stores the singleton key in `pgboss.job.singleton_key`; confirm the column name on the installed pg-boss version before writing the newest-job query. If it differs, filter on `data->>'actorUserId'` for Google and `data->>'connectorAccountId'` for IMAP instead.
- **Q2 (build agent, slice 1) — RESOLVED:** the retryable-deferral branch does run once per message per attempt, because the retry re-enqueues the same page. Resolved by identity rather than arithmetic: the run carries the set of deferred message external ids (`deferredKeys`, capped at `MAX_DEFERRED_KEYS = 500`) through the continuation payload, re-deferring an id already in the set is a no-op, and a later success removes it. `emailDeferred` is the size of that set, so it counts distinct message units and never exceeds `emailUpserted`. A job queued before this field existed carries only its old total, which is frozen as a baseline.

## 2. Determinism boundary

- Every sentence on the settings row, on Today, and in a Moss answer about sync comes from the
  shared explain module, which is pure and reads only stored facts. No model output is rendered.
- The module never injects turns into the host chat.
- The model has no job in this feature. The two tools return the explain module's output; Moss
  may rephrase it in conversation, but the tool result is what the screen shows.
- No model-authored value crosses into user data. `syncNow` writes only a job row with metadata.

## 3. Slices

Each slice is one agent session. All three commit to the same branch and PR. Each ends with the
unit and integration tests it names green, typecheck and eslint green on changed files, and the
release-note section of the PR kept current.

### Slice 1: Record and explain (no visible change)

**Migration** `packages/connectors/sql/0215_connector_sync_previous_run.sql`:

```sql
ALTER TABLE app.connector_accounts
  ADD COLUMN IF NOT EXISTS last_sync_trigger text
    CHECK (last_sync_trigger IS NULL OR last_sync_trigger IN ('schedule', 'manual', 'assistant', 'on-connect')),
  ADD COLUMN IF NOT EXISTS previous_sync jsonb;
COMMENT ON COLUMN app.connector_accounts.previous_sync IS
  'Snapshot of the prior finished run: {startedAt, finishedAt, status, errorCode, counts, trigger}. Counts only, never content.';
```

Add the file to the connectors manifest migration list. The admin-safe view is not touched.

**Repository** (`packages/connectors/src/repository.ts`):

```ts
export type ConnectorSyncTrigger = "schedule" | "manual" | "assistant" | "on-connect";
export interface PreviousSyncSnapshot {
  readonly startedAt: string | null; readonly finishedAt: string; readonly status: ConnectorSyncStatus;
  readonly errorCode: string | null; readonly counts: ConnectorSyncCounts; readonly trigger: ConnectorSyncTrigger | null;
}
markSyncStarted(scopedDb, accountId, input: { startedAt: Date; trigger: ConnectorSyncTrigger }): Promise<void>
markSyncFinished(scopedDb, accountId, input: { finishedAt: Date; status; error; counts: ConnectorSyncCounts }): Promise<void>
```

**Where the previous-run snapshot is taken (implemented, differs from the first draft above).**
`markSyncStarted` — not `markSyncFinished` — copies the row's current summary into
`previous_sync`, in the same UPDATE that stamps the new start time. This is forced by ordering:
`markSyncStarted` clears `last_sync_status` back to null when a run begins, so by the time that
run's own `markSyncFinished` executes, the prior run's status is already gone and there is
nothing left to copy. Reading it at run start, immediately before the same statement overwrites
it, is the only point where "the last good run" still exists on the row, and doing it in one
UPDATE keeps it atomic. The copy is skipped when there is no finished prior run (first sync
ever), so a first run leaves the snapshot absent rather than empty.

A consequence: `markSyncFinished` needs no `isContinuation` flag and no longer takes one. A
mid-run continuation chunk writing its outcome cannot disturb a snapshot it never touches, and
`markSyncStarted` is only called when a run actually begins, never for a continuation chunk.
`ConnectorAccountSafeRow` gains `previousSync` and `lastSyncTrigger`.

**Trigger plumbing:** the Google and IMAP job payloads gain `trigger` (a short string, metadata
only). Schedule registration sends `"schedule"`, the existing Google route sends `"manual"`,
sync-on-connect sends `"on-connect"`. The assistant tool (slice 2) sends `"assistant"`.

**Deferred AI counter:** `google-sync-phases.ts` progress gains `emailDeferred: number`, the
`deferredKeys` set behind it, and
`deferredReason: "assistant-login-expired" | "assistant-unavailable" | "structured-output" | null`;
`ConnectorSyncCounts` gains `emailDeferred?: number` and `deferredReason?: ... | null`. The reason
is carried through the continuation payload and saved with the counts as a code, never a message;
`deferredReasonSentence` in the shared explain module is the only place a code becomes words.
`EmailExtractRetryableReason` gains `"login-expired"` so an expired assistant sign-in is
classified rather than falling through to the generic structured-output reason.

**Shared explain module** `packages/shared/src/connector-sync-explain.ts` (no imports beyond
`connectors-api.ts` types):

```ts
export type ConnectorSyncExplainCode =
  | "revoked"
  | "syncing"
  | "queued"
  | "waiting-for-worker"
  | "sign-in-expired"
  | "connection-error"
  | "partial"
  | "capped"
  | "first-run-pending"
  | "synced"
  | "not-scheduled";
export interface ConnectorSyncExplainInput {
  /* exactly the fields in the spec's Explanations section */
}
export interface ConnectorSyncExplained {
  code;
  tone: "forest" | "amber" | "red" | "neutral";
  label;
  summary;
  reason;
  next;
  canReconnect;
  canSyncNow;
}
export function explainConnectorSync(
  input: ConnectorSyncExplainInput,
  now: Date
): ConnectorSyncExplained;
export const WAITING_FOR_WORKER_GRACE_MS = 120_000;
export interface ConnectorCapability {
  ability: string;
  dependsOn: "calendar-phase" | "email-phase" | "email-phase+assistant";
  staleAfterMs: number;
}
export interface NotWorkingEntry {
  ability: string;
  since: string | null;
  reason: string;
  fix: { label: string; path: string };
}
export function deriveNotWorking(
  map: readonly ConnectorCapability[],
  facts: ConnectorSyncExplainInput,
  now: Date
): NotWorkingEntry[];
```

Capability maps are static exports: `GOOGLE_CAPABILITIES` in `packages/connectors/src/google-capabilities.ts`
(three rows from the spec) and `IMAP_CAPABILITIES` in `imap-capabilities.ts` (two email rows).

**Web adapter:** `apps/web/src/settings/settings-connector-sync.ts` keeps its exports but
implements `getConnectorAccountHealth` by calling `explainConnectorSync`. The pane renders the
same words it does today, so no visible change yet.

**Tests (why each would fail against a broken build):**

- `tests/unit/connector-sync-explain.test.ts`: one case per code asserting `label`, `summary`,
  `reason`, `next`, `tone` from the spec's wording table; a `created` job 119 s old is `queued`
  and 121 s old is `waiting-for-worker` (a wrong comparison flips one of them); an unknown error
  code renders with dashes replaced by spaces (a missing fallback throws or shows the raw code).
- `tests/unit/connector-sync-not-working.test.ts`: expired sign-in on Google yields three
  entries; a partial run within the stale window yields none (a build that ignores
  `staleAfterMs` returns entries); the IMAP map never yields a calendar line; deferred AI with
  reason `assistant-login-expired` yields exactly "Tasks are not being created from email" with
  the assistant settings fix path.
- `tests/integration/connectors-previous-sync.test.ts` (gate): two finished Google runs leave
  `previous_sync` equal to the first run's summary and the columns holding the second; a
  continuation does not move it; an auth failure writes `failed` / `auth-error`; the same for
  IMAP. A build that copies after overwriting stores the new run twice.
- Existing pane tests keep passing (proves the adapter is word-for-word).

**Verification (expected exit 0 for each):**

```bash
pnpm --filter @moss/shared test > /tmp/s1-shared.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/connectors test > /tmp/s1-conn.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/s1-tc.log 2>&1; echo "EXIT=$?"
pnpm eslint <changed files> > /tmp/s1-lint.log 2>&1; echo "EXIT=$?"
```

The integration test runs only through the `verify-gate` skill (`scripts/run-gate.sh start`,
`wait`, `status`), never directly.

### Slice 2: Status and control (API and Moss)

**Jobs helper** `packages/jobs/src/pg-boss.ts`:

```ts
export interface NewestJobState {
  readonly jobId: string;
  readonly state: "created" | "retry" | "active";
  readonly createdAt: Date;
}
export async function newestInFlightJob(
  rootDb: Kysely<MossDatabase>,
  queueName: string,
  singletonKey: string
): Promise<NewestJobState | null>;
```

**Next-run helpers:** `google-schedule.ts` and `imap-schedule.ts` each export
`nextScheduledRunAt(now: Date): Date` computed from their cron constant; the route includes it
only when a schedule row exists for that actor or account (pg-boss `schedule` table query in the
same jobs helper: `hasSchedule(rootDb, queueName, singletonKey): Promise<boolean>`).

**Shared contracts** in `packages/shared/src/connectors-api.ts`: `ConnectorSyncStatusDto`,
`ListConnectorSyncStatusResponse`, `SyncConnectorAccountResponse`, and JSON schemas
`connectorSyncStatusResponseSchema`, `listConnectorSyncStatusResponseSchema`,
`syncConnectorAccountResponseSchema`, matching the spec's API contracts section field for field.

**Routes** in `packages/connectors/src/routes.ts`, each declared in `manifest.ts`:

- `GET /api/connectors/accounts/:id/sync-status` (`connectors.view`)
- `GET /api/connectors/sync-status` (`connectors.view`), no `previousRun`
- `POST /api/connectors/accounts/:id/sync` (`connectors.manage`), same rate-limit config as the
  Google route, trigger `"manual"`; picks the queue by `getAccountProviderType`
  (`repository.ts:378`); returns `{ queued: false, reason: "in-flight" }` on a null job id and
  `{ queued: false, reason: "revoked" }` for a revoked account.

A pure assembler `packages/connectors/src/sync-status.ts`:

```ts
export function buildSyncStatus(input: {
  account: ConnectorAccountSafeRow;
  pending: NewestJobState | null;
  scheduled: boolean;
  now: Date;
}): ConnectorSyncStatusDto;
```

so the route, the tool, and the tests share one function.

**Moss tools** in `manifest.ts`, beside the live Gmail and Calendar tools:

- `connectors.syncStatus`, `permissionId: "connectors.view"`, `risk: "read"`, input
  `{ accountId?: string }`, output the status contract (one account) or `{ accounts: [...] }`.
- `connectors.syncNow`, `permissionId: "connectors.manage"`, `risk: "write"`, input
  `{ accountId: string }`, trigger `"assistant"`, output `SyncConnectorAccountResponse`. No
  confirmation prompt (installing a module grants normal use).

**Manifest metadata:** `features: [{ id: "connectors.sync_status", ... }]`, `errors` for
`waiting-for-worker`, `sign-in-expired`, `assistant-login-expired`, each with `remediations`
pointing at `/settings?section=connected` or `/settings?section=assistant`. Core app map:
`app-map-core.ts` `connected` entry gains the sentence from the spec; the `today` entry gains
the "not working" sentence (rendered in slice 3, declared now so the map is never ahead of or
behind the tree by more than one slice of the same PR).

**Tests:**

- `tests/integration/connectors-sync-status-routes.test.ts` (gate): a 3-minute-old `created`
  job gives `waiting-for-worker`, a 30-second-old one gives `queued`, an `active` one gives
  `syncing` (a build using `hasInFlightJob` cannot tell these apart); a revoked account gives
  `not-scheduled` with `canSyncNow` false; another user's account id is 404.
- Same file: the per-account sync route queues on `connectors.google-sync` for a Google account
  and `connectors.imap-sync` for an IMAP account (a build that hard-codes Google fails the IMAP
  case), and returns `in-flight` on the second call.
- `tests/unit/connectors-sync-status-tool.test.ts`: `connectors.syncStatus` returns an object
  deep-equal to `buildSyncStatus` for the same inputs and refuses another user's account id;
  `connectors.syncNow` sends a job whose payload passes `assertMetadataOnlyPayload` and carries
  `trigger: "assistant"`.
- `tests/unit/app-map-truthfulness` (existing suite) passes with the new sentences.

**Verification (expected exit 0):** the four commands from slice 1 plus
`pnpm --filter @moss/jobs test > /tmp/s2-jobs.log 2>&1; echo "EXIT=$?"`.

### Slice 3: Screen, Today, and live proof

**Pane** (`apps/web/src/settings/settings-personal-data-panes.tsx`): `AccountRow` reads
`GET /api/connectors/accounts/:id/sync-status` through a new client function in
`apps/web/src/api/connectors.ts`; badge from `explained.tone` and `label`; summary line;
Details toggle (quiet small Button) revealing landed kinds with `seeAt` links, what failed, the
not-working list, the previous-run line; Sync now (secondary small Button) calling the new
route, disabled while `pending` is non-null, toast "Sync queued" or the refusal reason. The
existing 2 s in-flight refresh is reused. New authored classes go in
`apps/web/src/styles/settings-panes.css` beside the `acct__*` rules, tokens only. Run the
design-system invented-class audit before finishing.

**Today** (`apps/web/src/today/`): `NotWorkingBlock` component, rendered above the briefing
banner at `today-page.tsx:740` when any account's `notWorking` is non-empty, reading
`GET /api/connectors/sync-status` once; one line per ability, deduplicated across accounts, jds
Badge `red` with `dot`, each with its fix link.

**Tests:**

- `tests/unit/settings-connector-sync-row.test.tsx`: each code renders its label, summary and
  next line; Details reveals the previous-run line; Sync now is disabled while queued or syncing
  (a build that reads `lastSyncStatus` instead of `pending` leaves it enabled).
- `tests/unit/today-not-working-block.test.tsx`: hidden when every list is empty; two accounts
  with the same lost ability render one line.
- `tests/e2e/settings-connected-sync-status.spec.ts` (Playwright, mocked API via
  `mock-connectors-api.ts`): a mocked waiting-for-worker account shows the red badge and the
  queued sentence; pressing Sync now on a synced account posts to the per-account route and the
  row flips to Queued.
- `tests/live/connectors-sync-status.live.test.ts`: on the dev instance, sign in, read the
  Google row, assert the badge and summary match the explain module for the stored facts.

**Live-path proof on dev, recorded on the PR** (the exit criterion, done by the build agent with
the dev instance the session already runs): stop the dev worker, press Sync now, watch the row
reach Waiting for worker within 2 minutes 10 seconds; start the worker, watch counts appear and
the previous-run line fill on the second run; with the assistant login moved aside, watch Today
show "Tasks are not being created from email" with the fix link; ask Moss "why is my mail not up
to date" and record the answer. Screenshots go to disk and are attached cropped.

**Verification (expected exit 0):**

```bash
pnpm --filter @moss/web test > /tmp/s3-web.log 2>&1; echo "EXIT=$?"
pnpm test:e2e tests/e2e/settings-connected-sync-status.spec.ts > /tmp/s3-e2e.log 2>&1; echo "EXIT=$?"
```

Then the full gate through the `verify-gate` skill, and the release-hardening audit gate.

## 4. Kill gate (after phase 1 = slices 1 and 2, before slice 3 is started)

Owner: Ben. Observation: with slices 1 and 2 on dev and the assistant login deliberately
expired, Ben asks Moss "is my mail up to date, and why not?" If Moss's answer names the real
cause and the fix (the explain module's sentences), the screen slice proceeds. If Moss still
says it does not know, or names the wrong cause, stop: the data model is wrong and the screen
would only decorate it. The coordinator records the verdict on #2239.

## 5. Rulings ledger

- 2026-09-04 (this plan): there is no Sync now button in the Connected accounts pane today;
  the spec's "existing button" wording was wrong. Net-new UI in slice 3.
- 2026-09-04: `hasInFlightJob` (`packages/jobs/src/pg-boss.ts:168`) returns a boolean and
  cannot distinguish queued from active; a newest-job helper is needed.
- 2026-09-04: no counter exists for deferred AI extraction; `google-sync-phases.ts:418` only
  logs. `emailDeferred` is added in slice 1.
- 2026-09-04 (Ben): history is the last run and the one before, nothing older. Moss may press
  Sync now. Notices outside Settings name the lost ability.

## Review checklist

- [x] Spec approved and task issue open
- [x] Every assumed platform capability cited, or listed as an open question with an owner
- [x] No function bodies; signatures, DDL, manifest shape and test cases only
- [x] Determinism boundary stated; no model guidance in this feature
- [x] Each slice names its e2e test
- [x] Every verification command unpiped, with an expected exit code
- [x] Kill gate named, with an owner
- [x] Rejected option steelmanned in the spec (history table vs snapshot; heartbeat vs job age)
