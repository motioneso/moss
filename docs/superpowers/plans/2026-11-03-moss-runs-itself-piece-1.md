# Moss Runs Itself, Piece 1: Moss Reads Its Own Logs, Jobs, Settings and Code

**Spec:** docs/superpowers/specs/2026-11-03-moss-runs-itself-design.md (section 4)
**Task issue:** #3978 (Part of #3973)
**Status:** Revised after Codex review (2026-11-03). Pre-approved by Ben.

## 1. Scope

Read-only chat tools that let Moss explain why something behaves as it does. No repair and no code
change (pieces 2 and 4). No new screens, so no mockups; the only user surface is Moss's chat answer.

The first draft assumed nothing existed. The review found a diagnostics tool and a source reader
already shipped, so this piece is smaller than the design implies: audit first, then fill the
measured gaps.

## 2. Seams check

Verified at origin/main on 2026-11-03.

| Capability                                  | Evidence                                                                                                                                                                 | Finding                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Platform diagnostics tool                   | packages/settings/src/manifest.ts:862 (`settings.platformDiagnostics`), packages/settings/src/platform-diagnostics-tool.ts:3-30                                          | Exists. Sections: version, runtime, modules, errors, actions, source. Permission `settings.view`, actor-scoped. |
| Source reader                               | packages/settings/src/manifest.ts:825 (`app.readSource`), tests at app-action-tools.test.ts:188                                                                          | Exists. Relative `packages/*/src` or `apps/*/src`, max 400 lines. Not admin-gated.                              |
| Stored per-user Moss errors                 | packages/ai/src/repository.ts:2736 (`recordError`), table `app.moss_error_log` (packages/ai/sql/0183)                                                                    | Exists. AI errors only, not connector or job logs.                                                              |
| Diagnostics composed and injected into chat | packages/module-registry/src/index.ts:3927, packages/chat/src/gateway-services.ts:295                                                                                    | Exists. The public service route to reuse.                                                                      |
| Admin lookup inside a tool                  | packages/module-registry/src/index.ts:3949 (scoped admin lookup); `ToolContext` has `actorUserId` only (packages/module-sdk/src/index.ts:119)                            | Exists. Live database check with `ctx.actorUserId`; no new `AccessContext` fields.                              |
| Instance admin flag                         | packages/settings/src/repository.ts:481                                                                                                                                  | Exists.                                                                                                         |
| Job queue table reads                       | packages/jobs/src/module-job-sweep.ts:80 (`pgboss.queue`), :101 (`pgboss.job` via `rootDb`)                                                                              | Reads exist but run as the root role. Whether the chat role can read them is **unproven**.                      |
| Raw application logs                        | apps/api/src/server.ts:268 (pino to stdout, secret protection in apps/api/src/recording-logger-options.ts:2); worker logger apps/worker/src/worker.ts:206 (no redaction) | No stored, readable log. API and worker are separate processes (scripts/start-jarv1s.ts:199).                   |
| Version at runtime                          | Dockerfile:112-125, infra/docker-compose.prod.yml:160, .github/workflows/ci.yml:525                                                                                      | Wired already.                                                                                                  |
| Tool shape                                  | packages/settings/src/app-map-tool.ts:85 (`ToolExecute`)                                                                                                                 | Exists.                                                                                                         |

Open questions, owner is the builder, answered in Phase 0:

1. Which existing sections of `settings.platformDiagnostics` answer a real fault, and which come
   back empty?
2. Which database role would read `pgboss.job` for a chat tool, and does RLS or a grant block it?
3. Is an existing redaction function reusable for free-text log lines?

## 3. Decisions taken (review findings accepted)

- **Extend, do not duplicate.** New capability goes through the existing diagnostics service and
  `settings.platformDiagnostics` sections wherever it fits. A second tool is added only when a
  section cannot hold the data.
- **Privacy before visibility.** Every diagnostic record carries its owner at the point it is
  produced. Reads are actor-aware. A record from another owner, or with no known owner, returns
  only a metadata allowlist (time, level, component, connection kind, event code). Admins get no
  exception to this (hard invariant: no admin private-data bypass).
- **Admin gate is a live database check** on `ctx.actorUserId` inside the service. Never from tool
  arguments, never a new field on `AccessContext`. Settings does not import `apps/api` internals
  or query AI-owned tables; it uses a public service contract the host injects.
- **One shared, sanitized log sink for both processes.** A database table owned by the settings
  module (new migration in the module's `sql/`, never an applied one), written by the API and the
  worker through one diagnostics service. Bounded by row count, age and per-record bytes, with a
  purge job. This also keeps logs across a restart, which is when an admin asks. Log content never
  travels through pg-boss.
- **Sanitize before either destination.** The same sanitizer runs before a record is written to
  stdout and to the table, so secrets never exist in an unredacted copy. It covers nested errors,
  URL credentials, cookies, bearer tokens and oversized records, on top of the existing
  recording-secret protection.
- **Source reader stays reconciled, not duplicated.** `app.readSource` is not admin-gated today.
  The plan decides in Phase 3 whether to tighten it (admin-only) or leave it, with Ben's call
  recorded; it is not silently left inconsistent with the design.

## 4. Determinism boundary

Tool results are deterministic records: rows, counts, timestamps, bounded text. The model has two
jobs: choose which tools to call, and turn the returned facts into a plain-English cause. Guidance
for the tools stays under 150 words in total. There is no new UI, so no model-generated UI
feedback.

## 5. Phases

### Phase 0: Coverage audit (no product code)

Against a real dev instance, run `settings.platformDiagnostics` through a real chat turn for two
real faults: a connection whose helper is down (the Outlook case) and an unwanted news story. Record
in a note appended to this plan: what it answered, what it left empty, and why. Answer open
questions 1-3. This decides the size of Phases 1 and 2. If the tool already explains both faults,
the kill gate below ends the piece early.

### Phase 1: Job queue and connection state (ships alone)

Add sections to the existing diagnostics service: recent job runs, failures, stuck jobs, last
success per job kind, retries (metadata only per the job payload invariant), and connection state
(last good sync, bounded error label). Admin-only by the live check. Contracts to fix in the
detailed task list: section names, output schema bounds, and the injected job-read service
signature.

Tests (behaviour, and the reason each fails against a broken build):

- A non-admin gets a denial from the server and no diagnostic data. Spoofed admin claims in the tool
  arguments are ignored. A demoted admin is refused. A missing identity is refused.
- Two users, and two admins, cannot see each other's owned records beyond the metadata allowlist.
  Each privacy assertion must be observed failing with the check removed.
- A job row with a payload of private-looking content returns metadata only.
- Output over the cap is truncated and flagged.

E2E (real dev instance, Playwright): trigger a real failing job through a real app action, choosing
a unique marker that is not in the question. Sign in as the admin, ask Moss why it failed, and
assert both the exact safe fact in the answer and evidence that the diagnostics tool ran. Then sign
in as a non-admin and assert a server-side denial and no diagnostic data, not a model-written
refusal. No faked network responses. The test must fail if registration, injection, authorization
or privacy is broken.

### Phase 2: Raw log sink and reader (planned in detail after the kill gate)

Implements the shared sanitized sink in section 3, plus a `logs` section with filters (time, level,
component, connection), per-record and total byte caps, validated options, and a specified adapter
from pino records (level mapping, child bindings, failure of the sink never breaks the request path).
Existing custom streams, serializers and `logger: false` keep working. Tests: log storm, one huge
record, UTF-8 byte limits, sink error, a worker warning retrieved through chat (two-process test).

### Phase 3: Source access (planned in detail after the kill gate)

Reconcile `app.readSource` with the admin-only rule (Ben's call), and let diagnostics point at
source by path and line. Source stays inside the confined reader; `.env`-style and key files stay
denied.

## 6. Verification

Run from a script that keeps the real exit status (an `echo` after a command hides it):

```bash
pnpm typecheck > /mnt/unity-nvme/scratch/piece1-typecheck.log 2>&1; rc=$?; echo "EXIT=$rc"; exit $rc
```

Expect exit 0. The full gate and any database test run only through the verify-gate skill, and
CI's end-to-end step is listed separately because the local gate excludes it. Each phase also names
its focused test command and its Playwright command in the detailed task list.

## 7. App map and production

Each phase updates the app-map declarations in the same PR: the tool or section, the admin-only
rule, requirements, errors and remediations, process coverage (API and worker) and retention
limits. Anything that adds a required setting must also add it to the dev and prod deployment
config in the same PR, and Phase 2's migration must not break an existing install.

## 8. Kill gate

Owner: Ben. After Phase 0 and Phase 1, run both real faults again. Continue only if Moss names a
true cause backed by returned evidence, or names exactly which evidence is missing. Stop and
rethink if Moss still cannot explain either fault with Phase 1 in place. Judge it on
evidence-backed explanations and named gaps, not on logs alone proving the cause. If Phase 2 ships
and the sink is empty at the moment it is needed, reopen the storage design before Phase 3.

## 9. Rulings ledger

- The first plan draft claimed no diagnostics or source tools existed. Wrong: manifest.ts:825 and
  :862 ship them. Correction recorded here so it is not re-derived. (Codex review)
- A process-wide in-memory buffer was rejected: the API and worker are separate processes, an admin
  gate does not make shared logs private, and a restart loses it. (Codex review, blockers 1 and 2)
- Redacting only the buffer copy was rejected: stdout would keep the secret. Sanitize before both
  destinations. (Codex review, finding 3)
- Read container logs through the host: rejected. It needs piece 2's host helper and fails after
  the move off Docker.
- `pgboss.job` is read as the root role in module-job-sweep.ts:101, which does not prove a chat
  tool's role can. (Codex citation audit)
- Admin gating of existing routes is at routes.ts:928; tool-level gating uses the live check above.

## 10. Phase 0 findings (2026-11-04)

Evidence class is stated for every claim. "Live" means a real chat turn on the standing proof copy
of Moss (a production-like build of main at commit 0ca12f02b, signed in to Claude, account is an
instance admin). The diagnostics service, tool and News provider there match origin/main
(`git diff 0ca12f02b origin/main` over platform-diagnostics.ts, platform-diagnostics-tool.ts, news/
and module-registry/src/index.ts is empty). Two connectors files differ (manifest.ts and
outlook-calendar-browser.ts, 57 changed lines), so the Outlook line numbers below are read from origin/main
and were not exercised live. No network
response was faked or rewritten. Raw turns are not committed (they carry account data).

### 10.1 What each section returns

| Section | Source                                                                 | Scope                                                                                      | Finding                                                                                                                                       |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| version | `appMap.getBuildInfo()` (platform-diagnostics.ts:130)                  | build id only                                                                              | Live: "development" on a proof build. Says nothing about faults.                                                                              |
| runtime | `collectHostDiagnostics` (settings/src/host-diagnostics-collect.ts:14) | admin only (platform-diagnostics.ts:134), else the word "runtime" is added to `redactions` | Live: uptime, commit, deploy mode, three checks (database, pg-boss installed, multiplexer). No connection, helper or relay state.             |
| modules | per-module `diagnosticsProvider` (module-registry/src/index.ts:3644)   | actor, via RLS                                                                             | Only News registers one (packages/news/src/manifest.ts:89). Connectors, calendar, email, weather and every other module return an empty list. |
| errors  | `app.moss_error_log` (ai/src/repository.ts:2769)                       | actor, last 24 h, max 10                                                                   | AI-call errors only. Live: empty for both faults.                                                                                             |
| actions | `app.moss_action_audit_log` (ai/src/repository.ts:2555)                | actor, last 24 h, max 10                                                                   | Tool-call outcomes only. Live: empty.                                                                                                         |
| source  | `sourceInspector.search`, needs `query`                                | not admin gated                                                                            | Live: `filesScanned: 2000, truncated: true, matches: []`. A free-text question matches nothing; it is a code grep, not a cause.               |

Only the `runtime` section is admin gated. `errors`, `actions` and `modules` rely on RLS alone.

### 10.2 Fault A: Outlook calendar, helper down

- What the proof copy could do: Outlook is bound by operator env only
  (connectors/src/outlook-calendar-config.ts:17), so the proof copy has no binding
  (`GET /api/connectors/outlook-calendar` returned `available:false, state:"disconnected"`). A
  connection with a dead relay therefore could not be created there. The Proton Bridge email
  connection also cannot stand in: the connect route probes the host first and refuses to store
  an account when it is unreachable (connectors/src/imap-connection.ts:51). So the live turn tests
  the question and the tool, not a stored "relay down" record. Code evidence below covers the
  stored record.
- Live turn 1 (natural question): Moss never called `settings.platformDiagnostics`. It used the app
  map and the calendar read, then wrote that the helper was down. That claim came from the user's
  own words, not from any returned fact. It said it had no timestamp for how long.
- Live turn 2 (told to use the tool, module "connectors"): runtime ok, `modules: []`,
  `errors: []`, `actions: []`, source 0 matches. The model named no cause and said the tool
  "didn't surface anything about the Outlook browser connector".
- Code evidence of what exists but is invisible to the tool:
  - Health is stored per account in a preference (`connector.<id>.outlook_calendar_health`,
    outlook-calendar-jobs.ts:52) with state, `failures`, `attemptedAt`, `lastCompleteAt`.
  - An unreachable relay becomes `OutlookCalendarSourceError("partial","account")`
    (outlook-calendar-browser.ts:321-323). The worker stores `partial` (jobs.ts:160-164), the same
    label as an incomplete scan. The stage is not stored. Phase 1 can say "partial, N failures,
    last attempt T", not "relay unreachable", unless the connectors module changes. That change is
    outside this piece (read-only); record it as a gap, do not fix it here.
  - Email and Google accounts keep `last_sync_status`, `last_sync_error`, `last_sync_finished_at`
    on `app.connector_accounts` (packages/db/src/types.ts:621-640). Nothing reads them for
    diagnostics.
- Verdict: not explained. Missing evidence is connection state (last good sync, last attempt,
  failure count, bounded error label) and job-run state for the sync jobs.

### 10.3 Fault B: unwanted news story

- Live turn 1 (natural question about a Guardian story): Moss used the news tools and the app map,
  not diagnostics. It claimed the story "matched one of your followed topics", but the account has
  no custom topics (`customTopics: []` from `/api/news/personalization`), so that sentence was not
  backed by any fact it had. It said it had no tool that lists topics.
- Live turn 2 (told to use the tool, module "news"): the news provider returned one entry,
  `status: ok`, "News is current.", facts: state, last success time, snapshot age, item count 25,
  generations. Everything else empty. The model correctly said it holds no per-article provenance.
- Code evidence: the provider reports refresh health only (news/src/diagnostics-provider.ts:31-74)
  and its own contract forbids content (module-sdk/src/diagnostics.ts, "must never carry a
  headline"). The data to answer exists elsewhere: each story already carries `sourceKey`,
  `topicKey`, `topicLabels`, and the overview lists `enabledSources` including built-in publishers
  (`GET /api/news/overview`, live). Missing evidence is a per-story answer to "which source row,
  topic or built-in default produced this".
- Verdict: not explained. The tool proves the refresh worked; it cannot say why a story is there.
  This is a news-module gap more than a log or job gap, so the raw log sink (Phase 2) would not
  have helped either fault.

### 10.4 Model behaviour that matters for sizing

In both natural questions the model did not choose `settings.platformDiagnostics`. Nothing in the
prompt or tool guidance mentions it (grep over packages/chat and packages/ai finds no guidance
reference), and the tool is a deferred tool the model must look up first. Phase 1 therefore needs a
discoverability task as well as new data, or the new sections will not be used.

### 10.5 Open question answers

1. **Which sections answer a real fault?** None answered either fault (10.2, 10.3). `runtime`
   confirms the platform is healthy, which rules out a platform-wide cause. `modules` answers only
   for News refresh health. `errors` and `actions` were empty because neither fault writes to those
   tables.
2. **Which role reads `pgboss.job`, and do RLS or grants block it?** Chat tools run on the API's
   `appDb`, which connects as `jarvis_app_runtime` (apps/api/src/server.ts:246-251,
   packages/db/src/urls.ts:65). The scoped handle is a transaction on that same pool
   (packages/db/src/data-context.ts:60-73), so the role does not change.
   - Grants: `GRANT SELECT, INSERT ON pgboss.job TO jarvis_app_runtime` and the same on
     `job_common` and `queue` (infra/postgres/grants/0001_pgboss_runtime_grants.sql:10,14,25).
     `pgboss.bam` and `pgboss.warning` have no grant (same file, line 39-40).
   - Live check on the proof database: `has_table_privilege` is true for `jarvis_app_runtime` on
     `pgboss.job`, `job_common`, `queue`; false for `jarvis_auth_runtime`.
   - RLS: none. `relrowsecurity` is false on `job`, `job_common`, `queue`, and `pg_policies` has no
     pgboss rows (live). Neither runtime role has BYPASSRLS (live `pg_roles`).
   - Consequence: under `SET LOCAL ROLE jarvis_app_runtime` a scoped transaction read 1434 rows from
     1434 total, of which 1412 carry no matching `actorUserId` (live). The database gives no
     per-user protection on this table. Privacy has to be enforced in the query (filter on
     `data->>'actorUserId'`) and in the projection (never select `data` or `output` raw), and
     ownerless rows (scheduled sweeps, `__pgboss__send-it`) return the metadata allowlist only.
     This is why Phase 1 needs the privacy tests to fail with the filter removed.
3. **Is a redaction function reusable for free-text log lines?** Partly.
   - `redactSecrets` (packages/ai/src/adapters/redact.ts:32) masks `Bearer`, `jst_` tokens,
     provider key prefixes, secret query parameters, `KEY=value` and JSON secret fields. Run live
     on sample lines: it masks `Authorization: Bearer ...`, `?token=...`, `password=...`.
   - It does NOT mask URL credentials (`https://bob:hunter2@host` passes through unchanged), `Cookie`
     and `Set-Cookie` values, or anything inside a nested error object (it takes a string only).
     Verified by running it on those inputs.
   - Reuse path: `@moss/ai` depends on `@moss/settings`, so settings cannot import it. Phase 2
     must move the function to a package both can import (`@moss/shared` or `@moss/module-sdk`)
     and extend it. Phase 1 returns no free text from logs, so it is not needed there.
   - The Fastify logger redaction (apps/api/src/recording-logger-options.ts:2) is path-based for
     request headers and bodies, so it cannot sanitize a message string. The worker logger has
     none (apps/worker/src/worker.ts:206).

### 10.6 Size recommendation

- Kill gate: the tool explains neither fault today, so the piece is not ended early.
- Phase 1 is one session if kept to the list below, but only if the Outlook stage gap is left as a
  recorded gap. Split in two PRs on one branch only if the context warning arrives: 1A (job
  section, admin gate, tool guidance) then 1B (connection state). Medium-large.
- Phase 2 is a full session on its own and should be re-planned after the Phase 1 kill-gate rerun.
  Phase 0 shows neither real fault needed raw logs, so Phase 2's value is unproven. Recommend
  deferring it until a fault appears that jobs and connection state cannot explain.
- Add a News "why is this story here" fact (source key, topic labels, built-in versus added) as a
  new Phase 1C task, because fault B cannot be explained without it and it needs no log sink. This
  belongs to the News module's provider, within the existing scalar-facts limit
  (module-sdk/src/diagnostics.ts, MODULE_DIAGNOSTIC_LIMITS), or a second provider if it does not
  fit. Flag to Ben: it widens scope beyond "jobs and connection state".

## 11. Phase 1 detailed task list

Branch per the task issue. TDD on every task: write the failing test first and observe the
failure named below. Verification commands follow section 6; database tests run only through the
verify-gate skill. All new reads go through the existing public service route
(`createPlatformDiagnosticsService`, packages/ai/src/platform-diagnostics.ts) and its host wiring
(packages/module-registry/src/index.ts:3927); no new tool unless task 1.1 shows a section cannot
hold the data.

### Task 1.0: Fix the contracts (types only, no behaviour)

Files: packages/ai/src/platform-diagnostics.ts, packages/settings/src/platform-diagnostics-tool.ts.

- Add `"jobs"` and `"connections"` to the `DiagnosticInclude` union and to `DIAGNOSTIC_SECTIONS`
  and the tool input enum. Add `jobs` and `connections` to `PlatformDiagnosticsReport` and to
  `platformDiagnosticsOutputSchema` (required, `additionalProperties:false`). Defaults of
  `includeSet` stay `version, runtime, modules, errors, actions`; the new sections are opt-in so
  existing callers and prompt size do not change.
- New exported types in packages/ai/src/platform-diagnostics.ts:
  `JobRunObservation { occurredAt, queue, state, retryCount, ownerKnown:boolean, kind: string|null,
connectorAccountId: string|null, errorLabel: string|null }`,
  `JobSummaryObservation { queue, lastSuccessAt: string|null, lastFailureAt: string|null,
failedLast24h:number, stuckCount:number, activeCount:number }`,
  `JobsSection { recent: JobRunObservation[]; summaries: JobSummaryObservation[]; truncated:
boolean }`, `ConnectionObservation { provider, accountId, status, lastAttemptAt, lastGoodAt,
failureCount, errorLabel }` and `ConnectionsSection { items: ConnectionObservation[];
truncated: boolean }`. All string fields are bounded (a maximum length constant exported with the
  type, 120 for labels), arrays capped at 10 to match `limitFor`.
- Add the injected job reader to the service dependencies:
  `readJobs: (scopedDb: DataContextDb, ctx: {actorUserId; requestId}, opts: {limit:number;
queuePrefix?: string; since: Date}) => Promise<JobsSection>`; and
  `readConnections: (scopedDb, ctx, opts: {limit:number}) => Promise<ConnectionsSection>`.
  Both optional so older composition roots compile; absent means the section name is pushed onto
  `redactions` (the same convention as `runtime` and `source`).
- Test (unit, tests/unit/platform-diagnostics-tool.test.ts): the schema rejects an unknown
  section name and accepts `jobs`. Fails on a broken build because the enum would not contain it.

### Task 1.1: Job reader

Files: packages/jobs/src/job-diagnostics.ts (new, exported from packages/jobs/src/index.ts),
tests/integration/job-diagnostics.test.ts (new).

- Signature: `readJobDiagnostics(db: Kysely<MossDatabase>, opts: { actorUserId: string; limit:
number; queuePrefix?: string; since: Date; stuckAfterSeconds?: number }): Promise<JobsSection>`.
  Takes the scoped handle's `.db`; runs as `jarvis_app_runtime` (finding 10.5 answer 2).
- Projection rules, enforced in SQL not after the fact: select only `name, state, retry_count,
created_on, started_on, completed_on`, and the single payload keys `actorUserId`, `kind`,
  `connectorAccountId`. Never select `data` or `output` as a whole. `errorLabel` is a fixed label
  derived from `state`/retry count (for example `failed`, `retrying`, `expired`) and never the pg-boss
  `output` text, because that column can carry arbitrary error text.
- Ownership: a row is owned by the caller only when `data->>'actorUserId' = $actor`. A row with a
  different or missing owner returns time, queue, state and retry count only, with `kind` and
  `connectorAccountId` set to null and `ownerKnown:false`. Admins get no exception.
- Stuck means state `active` with `started_on` older than `stuckAfterSeconds` (default 900) or
  `created`/`retry` past `start_after` by the same margin.
- Test cases (behaviour, why each fails on a broken build):
  1. Owned failed job shows kind and state. Fails if the filter or projection drops owned detail.
  2. Another user's job shows only the allowlist (queue, state, times) with `kind:null`. Observe it
     failing with the ownership comparison removed (kind would leak).
  3. A job whose payload holds private-looking content (`params: {note: "SECRET-MARKER"}`) never
     returns that string anywhere in the serialized result. Fails if `data` is selected whole.
  4. A failed job whose `output` holds `SECRET-MARKER` returns only the fixed label. Fails if
     `output` is passed through.
  5. More rows than `limit` returns `limit` rows and `truncated:true`. Fails if the cap is missing.
  6. A stuck active job is counted in `stuckCount`; a recent active job is not. Fails on a wrong
     threshold.
  7. Ownerless scheduled sweep rows (no actorUserId) are counted in summaries but listed as
     `ownerKnown:false`.
  8. Run the query as `jarvis_app_runtime` (use the scoped data context, not the migration owner),
     proving the grants suffice. Fails if the SQL touches `pgboss.bam` or `pgboss.warning`.
- Command: `pnpm test:integration tests/integration/job-diagnostics.test.ts` through verify-gate.

### Task 1.2: Connection reader

Files: packages/connectors/src/connection-diagnostics.ts (new, exported from the package index),
tests/integration/connection-diagnostics.test.ts (new).

- Signature: `readConnectionDiagnostics(scopedDb: DataContextDb, opts: { limit: number }):
Promise<ConnectionsSection>`. Uses the connectors module's own repository (module isolation:
  the host injects it; the ai package never queries `connector_accounts`).
- Sources: `connector_accounts.status/last_sync_started_at/last_sync_finished_at/last_sync_status/
last_sync_error`, and the Outlook health preference. `errorLabel` is a bounded mapping from
  `last_sync_error` and the Outlook state to a fixed vocabulary; raw `last_sync_error` text is
  never returned, because it may contain provider messages.
- Outlook: surface `state`, `failures`, `attemptedAt`, `lastCompleteAt`. Do not claim "relay
  unreachable"; `partial` with failures greater than zero reads as "scan incomplete or helper
  unreachable (not distinguishable)". Record the gap in the app-map error entry.
- Test cases: (1) an account with a failed last sync returns status, last attempt and a fixed
  label, and no raw error string (fails if raw text is passed); (2) a second user's account never
  appears (observe failing with the RLS-scoped handle replaced by a raw handle); (3) a revoked
  account is reported as revoked, not as healthy; (4) Outlook `sign-in-needed` and `partial`
  states map to distinct labels.

### Task 1.3: Wire the sections into the service with the live admin gate

Files: packages/ai/src/platform-diagnostics.ts, packages/module-registry/src/index.ts (host
wiring near :3927), tests/unit/platform-diagnostics.test.ts, tests/integration/platform-diagnostics.test.ts.

- In `observe`, for `jobs` and `connections`: call `dependencies.isInstanceAdmin(scopedDb,
ctx.actorUserId)` (live lookup, same function the runtime section uses at :134). Non-admin: push
  the section name onto `redactions` and return an empty section. The admin flag is never read from
  tool arguments (the tool already rejects unknown input keys, platform-diagnostics-tool.ts:222).
- Inject `readJobs` from `@moss/jobs` and `readConnections` from `@moss/connectors` in the host
  wiring. Truncate to the per-record and total byte cap (reuse the existing 10-item cap, plus a
  16 KB serialized cap: over the cap, drop items from the end and set `truncated:true`).
- Test cases (all must be observed failing with the check removed):
  1. Non-admin gets `redactions` containing `jobs` and `connections` and empty sections. Fails if
     the gate is removed.
  2. A tool call whose arguments include `isInstanceAdmin:true` or `actorUserId:<other>` is
     rejected (existing key check), and a non-admin session gains nothing.
  3. A user demoted between two calls is refused on the second call (live lookup, not cached).
  4. A missing identity is refused before any read.
  5. Two admins each see their own owned job detail and only the allowlist for the other's.
  6. Output over the cap is truncated and flagged.
- Command: `pnpm test:unit` scoped to the two unit files, then the integration file through
  verify-gate.

### Task 1.4: Make the tool discoverable (the 10.4 finding)

Files: packages/settings/src/manifest.ts (tool description, :862), the chat tool guidance file
that lists the tools the model should prefer (locate with the codebase-memory skill; start from
packages/chat/src/live/persona-guidance.ts), tests/unit alongside.

- Rewrite the `settings.platformDiagnostics` description to say when to use it (a connection,
  sync, job or refresh is not working, or the user asks why something happened) and that the
  `jobs` and `connections` sections are admin only. One guidance sentence in the chat prompt
  pointing "why is X broken" questions at it. Total new guidance stays under 150 words.
- Test: a prompt-composition test asserts the sentence appears and that the guidance total is
  under the word cap. Fails on a build without the sentence.

### Task 1.5: App map and release note

Files: packages/shared/src/app-map-core.ts or the settings manifest `features` metadata, per
docs/DEVELOPMENT_STANDARDS.md "App Map Truthfulness".

- Declare the two new sections, the admin-only rule, the requirement (instance admin), the
  "section hidden for non-admins" outcome and remediation, and the Outlook partial-state gap.
  Release note: Category N/A unless the tool becomes user-visible beyond admins.
- Test: the existing app-map coverage test still passes and a new entry assertion fails without
  the declarations.

### Task 1.6: Live proof (Playwright and real chat)

Files: tests/e2e or tests/uat per the existing pattern for live chat proofs (see
test:uat scripts in package.json).

- Cause a real failing job through a real app action. A unique marker string not present in the
  question is placed in the failing job's connector name. Sign in as the admin, ask Moss why it
  failed, and assert the answer contains the exact safe fact (queue and state) and that the
  conversation's recorded tool activity includes `settings.platformDiagnostics`. Sign in as a
  non-admin and assert a server-side `redactions` entry and no job data (not a model-written
  refusal). No faked network responses. The test must fail when registration, injection,
  authorization or privacy is broken.
- Rerun both Phase 0 faults on the same proof copy and record the result for the kill gate.

### Task 1.7 (needs Ben's agreement, see 10.6): News "why is this story here"

Files: packages/news/src/diagnostics-provider.ts, packages/news/src/personalization-repository.ts.

- Add one provider observation (`providerId: "news.provenance"`) with scalar facts: counts of
  stories by built-in source, by added source, by topic, and the exclusion count. Per-story
  detail stays out because the provider contract forbids content; a per-story answer needs a
  separate decision (a tool argument of story id, owner-only).
- Test: counts change when a source is excluded; no headline text appears in the output. Fails
  if story titles are included.

## 12. Phase 2 detailed task list: raw log store and `logs` section

Ben ruled on 2026-11-04 to build Phase 2 now. This overrides the section 10.6 advice to defer it. It
does not remove the section 8 rule that an empty store at the moment of need reopens the storage
design. Phase 2 builds on the Phase 1 contracts in PR 3981 (not yet merged when this was written):
section types in packages/module-sdk/src/platform-diagnostics-types.ts, the `capSection` helper and
live admin check in packages/ai/src/platform-diagnostics.ts, and the injected-reader pattern wired
at packages/module-registry/src/index.ts near :3953. Rebase on main after PR 3981 merges and
re-cite any line that moved.

### 12.1 Seams check (origin/main, 2026-11-04)

| Capability                     | Evidence                                                                                                                                                                                             | Finding                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API logger                     | apps/api/src/server.ts:267-269 (`Fastify({ logger: recordingLoggerOptions(options.logger) })`), apps/api/src/recording-logger-options.ts:19-34                                                       | The wrapper adds path redaction and keeps the caller's stream. `false` stays `false`. The sanitizing destination goes in here.                                           |
| API database handles           | apps/api/src/server.ts:254 (app role, and a worker-role handle `workerDb` created before Fastify)                                                                                                    | The worker-role handle exists before the logger is built, so the sink can bind it with no reordering in the API.                                                         |
| Worker logger                  | apps/worker/src/worker.ts:206-209 (`pino({ level, base:{process:"worker"} })`), `workerDb` created at :212                                                                                           | Logger is built before the database handle. Task 2A.5 reorders them. No redaction today.                                                                                 |
| Two processes                  | scripts/start-jarv1s.ts:182-183 (migrate runs as a one-shot first), :200 (API entry; the worker is the entry above it)                                                                               | Migrations finish before either process starts. A missing table is still tolerated (12.4).                                                                               |
| Scheduled purge pattern        | packages/settings/src/data-export-schedule.ts:4-12 (queue, cron, `boss.schedule`), packages/settings/src/data-export-jobs.ts:253-275 (`registerSettingsJobWorkers` registers the cleanup worker)     | Worker is the sole cron owner (apps/worker/src/worker.ts:117-136). A second queue in the same registration function follows the same pattern.                            |
| Security-definer cleanup       | packages/settings/sql/0112_data_export_cleanup_function.sql (policy for the migration owner, definer function, execute granted to the worker role only)                                              | Precedent for a purge and a read function that bypass row policies without any runtime role holding BYPASSRLS.                                                           |
| Owner-only table precedent     | packages/settings/sql/0108_data_export_jobs.sql (RLS enabled and forced, owner policy on `app.current_actor_user_id()`)                                                                              | Same classification style.                                                                                                                                               |
| Runtime roles                  | infra/postgres/grants/0001_pgboss_runtime_grants.sql:1-40                                                                                                                                            | Roles are `jarvis_app_runtime` (API requests, chat tools) and `jarvis_worker_runtime`. The new table grants follow the same split.                                       |
| Chat tools use the app role    | Phase 0 finding 10.5 answer 2 (apps/api/src/server.ts:246-251)                                                                                                                                       | The `logs` reader runs as the app role. It cannot read the table directly (12.3), only through a function.                                                               |
| Actor binding on log lines     | packages/module-registry/src/route-guard.ts:297 and :320-323 (the request hook resolves `actorUserId` for module routes only); no `log.child` with an actor exists in apps/api/src                   | Nothing tags a log line with its owner today. Task 2B.1 adds the binding and states which routes it covers. Untagged lines are unowned and metadata-only.                |
| Existing redaction             | packages/ai/src/adapters/redact.ts:32 (`redactSecrets`); a second copy at packages/cli-runner/src/stderr-redactor.ts                                                                                 | Lives in `@moss/ai`, which depends on `@moss/settings`, so settings cannot import it (Phase 0 finding 10.5 answer 3). Misses URL credentials, cookies and nested errors. |
| Where a shared module can live | packages/shared/package.json:6-9 (exports map; deps are only module-sdk and priority); apps/api/package.json:23-24 lists settings and shared; apps/worker/package.json:24 lists settings, not shared | `@moss/shared` is a leaf both processes can reach (the worker gains one dependency line). `@moss/settings` already reaches both and depends on shared.                   |
| Next free migration number     | origin/main highest is 0356 (packages/ai/sql/0356_module_page_activity_surface.sql). Open PRs hold 0346 (PR 3571), 0354 (PR 3868), 0355 (PR 3859)                                                    | The next free number is 0357. Collision rule in 12.4.                                                                                                                    |
| App-map metadata               | packages/settings/src/platform-diagnostics-features.ts (added by PR 3981)                                                                                                                            | The `limits` feature there says "Moss cannot yet show application log lines". Phase 2 must change that sentence or it becomes false.                                     |
| Real chat proof pattern        | package.json scripts `test:uat:*`, tests/uat/run-uat.ts, tests/uat/real-chat-env.ts                                                                                                                  | Real-chat proofs run through the UAT runner, not the Playwright mock specs under tests/e2e (those fake their own responses).                                             |

Open questions, each owned by the 2B builder and answered in Task 2B.0 before any code:

1. Which real worker job emits a warning that carries its owner, so the two-process proof needs no
   test-only route? Candidate: a connector sync against an unreachable host. If none exists, add the
   owner binding to the nearest real handler; do not add a debug endpoint.
2. Which API routes can bind the actor to the request logger (module routes through route-guard.ts
   only, or a global hook after authentication)? Write the answer into the app-map limits entry.

### 12.2 Decisions

- **One sink, two writers, one reader.** A table owned by the settings module. The API and worker
  both write through one exported sink. The only reader is the diagnostics service.
- **Sanitizer scope.** A pure function module in `@moss/shared`, run before a record reaches stdout
  and before it reaches the table. It must cover each of these, and each has its own test:
  - Strings: bearer and token prefixes, provider key prefixes, secret query parameters, secret
    assignments and secret JSON fields (everything `redactSecrets` covers today).
  - URL credentials of the form `scheme://user:password@host`. Mask the password, keep user and host.
  - `Cookie` and `Set-Cookie` header values, whole value masked, name kept.
  - `Authorization` header values of any scheme (Basic, Bearer, Digest).
  - Nested errors: walk an `Error`, its `cause` chain, an `errors` array, and any plain object or
    array, to depth 6, with a visited set so a cycle does not hang. Keys named like secrets
    (password, token, secret, apiKey, authorization, cookie, credential) are masked by key, not only
    by value shape.
  - Oversize: after masking, cut `message` to 2048 UTF-8 bytes and the serialized context to 2048
    bytes, never splitting a character, and set `truncated`. A single record never exceeds 4 KB.
  - Failure of the sanitizer itself drops the record and counts it. It never falls back to writing
    the raw record.
- **`redactSecrets` is extended in shared and re-exported from `@moss/ai`.** The ai file keeps its
  export name and every current caller keeps working. The cli-runner copy is left alone (separate
  contract, out of scope).
- **What is stored.** Level warn (40) and above only. Info and debug stay on stdout. Reason: info is
  the storm level, and the question Moss answers is "what went wrong". Constants, not a setting.
- **Owner tagging.** The owner is the top-level `actorUserId` field of the log line, accepted only if
  it is a valid uuid, else null. Nothing infers an owner from message text.
- **Privacy classification.** Table `app.diagnostic_log_records` is owner-or-unowned, read through a
  function. A row whose `owner_user_id` equals the caller returns full message and context. Every
  other row (other owner, or no owner) returns only time, level, process, component, connection
  kind and event code. No admin exception. No role holds BYPASSRLS. The function also returns
  nothing at all to a non-admin, as a second gate behind the service's live check.
- **Write path never breaks a request.** The sink is a bounded in-memory queue with a background
  flush. The log call returns before any database work. All sink failures are swallowed and counted.
  The sink never logs through the logger it feeds (recursion guard) and reports at most one line per
  minute to stderr.
- **Bounds.** Row cap 50,000. Age cap 7 days. Per record 4 KB. Queue 500 records per process. Write
  rate 200 records per minute per process; extra records are dropped and summarised by one
  `log.dropped` record per minute with the count. Reader output follows 12.3 and 12.6.
- **No new required setting.** Retention numbers are constants. No dev or prod compose or env change
  is needed. The PR states this and shows a grep over infra/docker-compose.prod.yml and the dev
  compose file for any log-related key, to prove nothing is missing.
- **Log text may still hold private data a pattern cannot recognise** (a mail subject inside a
  message). Mitigated by owner-only visibility of message text, the 7-day age cap, and the user
  deletion cascade. Recorded as a known limit in the app map, not claimed as solved.

### 12.3 Contracts

New migration: packages/settings/sql/0357_diagnostic_log_records.sql (number per 12.4).

```sql
CREATE TABLE IF NOT EXISTS app.diagnostic_log_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  process         text NOT NULL CHECK (process IN ('api', 'worker')),
  level           smallint NOT NULL CHECK (level BETWEEN 40 AND 60),
  component       text NOT NULL CHECK (char_length(component) <= 80),
  connection_kind text CHECK (connection_kind IS NULL OR char_length(connection_kind) <= 40),
  event_code      text CHECK (event_code IS NULL OR char_length(event_code) <= 80),
  owner_user_id   uuid REFERENCES app.users(id) ON DELETE CASCADE,
  message         text NOT NULL CHECK (octet_length(message) <= 2048),
  context         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(context::text) <= 2048),
  truncated       boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS diagnostic_log_records_time_idx
  ON app.diagnostic_log_records (occurred_at DESC);
CREATE INDEX IF NOT EXISTS diagnostic_log_records_owner_time_idx
  ON app.diagnostic_log_records (owner_user_id, occurred_at DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS diagnostic_log_records_component_idx
  ON app.diagnostic_log_records (component, occurred_at DESC);

ALTER TABLE app.diagnostic_log_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.diagnostic_log_records FORCE ROW LEVEL SECURITY;

-- The worker role (used by both processes for log writes) may insert only.
DROP POLICY IF EXISTS diagnostic_log_records_insert ON app.diagnostic_log_records;
CREATE POLICY diagnostic_log_records_insert ON app.diagnostic_log_records
  FOR INSERT TO jarvis_worker_runtime WITH CHECK (true);
GRANT INSERT ON app.diagnostic_log_records TO jarvis_worker_runtime;

-- The migration owner reads and deletes for the definer functions below. No runtime role gets
-- SELECT or DELETE on the table.
DROP POLICY IF EXISTS diagnostic_log_records_definer_select ON app.diagnostic_log_records;
CREATE POLICY diagnostic_log_records_definer_select ON app.diagnostic_log_records
  FOR SELECT TO jarvis_migration_owner USING (true);
DROP POLICY IF EXISTS diagnostic_log_records_definer_delete ON app.diagnostic_log_records;
CREATE POLICY diagnostic_log_records_definer_delete ON app.diagnostic_log_records
  FOR DELETE TO jarvis_migration_owner USING (true);

-- Reader: app role only. Admin check inside, owner rows full, all other rows metadata only.
CREATE OR REPLACE FUNCTION app.read_diagnostic_log(
  p_since timestamptz, p_min_level smallint, p_component text,
  p_connection_kind text, p_limit integer)
RETURNS TABLE(
  occurred_at timestamptz, process text, level smallint, component text,
  connection_kind text, event_code text, owned boolean, owner_known boolean,
  message text, context jsonb, truncated boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT r.occurred_at, r.process, r.level, r.component, r.connection_kind, r.event_code,
         (r.owner_user_id = app.current_actor_user_id()) AS owned,
         (r.owner_user_id IS NOT NULL) AS owner_known,
         CASE WHEN r.owner_user_id = app.current_actor_user_id() THEN r.message END,
         CASE WHEN r.owner_user_id = app.current_actor_user_id() THEN r.context END,
         r.truncated
  FROM app.diagnostic_log_records r
  WHERE app.current_actor_is_admin()
    AND r.occurred_at >= p_since
    AND r.level >= p_min_level
    AND (p_component IS NULL OR r.component = p_component)
    AND (p_connection_kind IS NULL OR r.connection_kind = p_connection_kind)
  ORDER BY r.occurred_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;
-- The admin check is app.current_actor_is_admin() (migration 0050, infra/postgres/migrations/
-- 0050_multi_user_accounts.sql:27-40): an active user with is_instance_admin = true. It is NOT a
-- check on the bootstrap owner flag, so an active admin who is not the bootstrap owner passes. A
-- plain read of app.users by the app role would wrongly reject that admin because the app role
-- sees only its own user row (the same reason 0050 added the definer helper).

CREATE OR REPLACE FUNCTION app.diagnostic_log_coverage()
RETURNS TABLE(oldest_at timestamptz, newest_at timestamptz, row_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT min(r.occurred_at), max(r.occurred_at), count(*)
  FROM app.diagnostic_log_records r
  WHERE app.current_actor_is_admin();
$$;
-- Same admin gate. Returns the retained time window and count, no content. A non-admin gets one
-- row of nulls and zero, which the reader maps to the empty section.

-- Purge: worker role only.
CREATE OR REPLACE FUNCTION app.purge_diagnostic_log(p_max_age interval, p_max_rows integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$ ... $$;
-- Contract: delete rows older than p_max_age, then the oldest rows beyond p_max_rows, in batches of
-- 5000, and return the count deleted.

REVOKE ALL ON FUNCTION app.read_diagnostic_log(timestamptz, smallint, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.diagnostic_log_coverage() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_diagnostic_log(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_diagnostic_log(timestamptz, smallint, text, text, integer)
  TO jarvis_app_runtime;
GRANT EXECUTE ON FUNCTION app.diagnostic_log_coverage() TO jarvis_app_runtime;
GRANT EXECUTE ON FUNCTION app.purge_diagnostic_log(interval, integer) TO jarvis_worker_runtime;
```

The `...` bodies are written against a real database in Task 2A.2. The signatures, grants and
rules above are the contract. The migration is re-runnable (`IF NOT EXISTS`, `OR REPLACE`, and
`DROP POLICY IF EXISTS` before each policy, as in 0112).

TypeScript contracts.

Package `@moss/shared`, new file packages/shared/src/log-sanitizer.ts, exported from
packages/shared/src/index.ts:

- `sanitizeLogText(text: string): string`
- `sanitizeLogValue(value: unknown, opts?: { maxDepth?: number }): unknown`
- `sanitizeLogRecord(raw: Record<string, unknown>): SanitizedLogRecord | null` (null means drop)
- `utf8Truncate(text: string, maxBytes: number): { text: string; truncated: boolean }`
- `interface SanitizedLogRecord { occurredAt: string; process: "api" | "worker"; level: 40 | 50 | 60; component: string; connectionKind: string | null; eventCode: string | null; ownerUserId: string | null; message: string; context: Record<string, unknown>; truncated: boolean }`
- Constants `LOG_MESSAGE_MAX_BYTES = 2048` and `LOG_CONTEXT_MAX_BYTES = 2048`.

Package `@moss/settings`, new files packages/settings/src/diagnostic-log-sink.ts and
packages/settings/src/diagnostic-log-destination.ts, both exported from the package index:

- `createDiagnosticLogSink(opts: { db: Kysely<MossDatabase>; process: "api" | "worker"; now?: () => number; stderr?: (line: string) => void }): DiagnosticLogSink`
- `interface DiagnosticLogSink { enqueue(record: SanitizedLogRecord): void; flush(): Promise<void>; close(): Promise<void>; stats(): { queued: number; written: number; dropped: number; failed: number } }`.
  `enqueue` is synchronous and never throws.
- `createSanitizedLogDestination(opts: { process: "api" | "worker"; destination: NodeJS.WritableStream; sink: DiagnosticLogSink | null }): NodeJS.WritableStream`.
  Each incoming pino line is parsed, sanitized, written to `destination` as sanitized JSON, and
  enqueued if level is 40 or higher. A line that does not parse as JSON is written to the
  destination after `sanitizeLogText` and is not stored.
- `withLogOwner<T extends { child(bindings: Record<string, unknown>): T }>(logger: T, actorUserId: string): T`
  binds `actorUserId` on a child logger.
- `purgeDiagnosticLog(db: Kysely<MossDatabase>): Promise<number>` calls the purge function with
  7 days and 50,000 rows. `DIAGNOSTIC_LOG_PURGE_QUEUE = "diagnostics.log_purge"` and
  `DIAGNOSTIC_LOG_PURGE_CRON = "43 * * * *"`, registered in `registerSettingsJobWorkers`
  (packages/settings/src/data-export-jobs.ts:253). The job payload carries only `{ kind }`.

Package `@moss/module-sdk`, appended to packages/module-sdk/src/platform-diagnostics-types.ts:

- `type LogLevelName = "warn" | "error" | "fatal"`
- `interface LogRecordObservation { occurredAt: string; process: "api" | "worker"; level: LogLevelName; component: string; connectionKind: string | null; eventCode: string | null; ownerKnown: boolean; owned: boolean; message: string | null; truncated: boolean }`
- `interface LogsSection { records: readonly LogRecordObservation[]; coverage: { oldestAt: string | null; newestAt: string | null }; truncated: boolean }`
- `EMPTY_LOGS_SECTION`. Message strings in this output are cut to 500 characters.

Package `@moss/ai`, packages/ai/src/platform-diagnostics.ts: add `"logs"` to the include union,
`logs: LogsSection` to the report, and an optional injected
`readLogs?: (scopedDb: DataContextDb, ctx: { actorUserId: string; requestId: string }, opts: { limit: number; since: Date; minLevel: LogLevelName; component?: string; connectionKind?: string }) => Promise<LogsSection>`.
It uses the same live admin check and the same `capSection` as `jobs`. A non-admin, or an absent
reader, pushes `"logs"` onto `redactions`.

Tool input (packages/settings/src/platform-diagnostics-tool.ts): `logs` is a new optional object,
added to `INPUT_KEYS`, with `sinceMinutes` (integer 1 to 1440, default 60), `minLevel` (enum warn,
error, fatal; default warn), `component` (string, max 80) and `connectionKind` (string, max 40),
`additionalProperties:false`. The `include` maximum grows by one. The output schema gains `logs`.

### 12.4 Migration number and collision

At the start of Task 2A.2, run `git fetch` and list the highest number across `packages/*/sql`, `packages/*/src/sql` (scripts/check-migration-collisions.ts:11) and
`infra/postgres/migrations` at origin/main and across open pull requests (the same data
scripts/check-migration-collisions.ts reads). Use the next free number. On 2026-11-04 that is
0357; open PRs hold 0346, 0354 and 0355. Run the collision script before the first push and again
before enabling auto-merge. If it reports a clash, rename the file before it is applied anywhere.
Never renumber a file that has already merged. Never edit an applied migration. Module SQL stays in
packages/settings/sql, never in infra/postgres/migrations.

If the table is missing at runtime (a start-order surprise), the sink sees SQLSTATE 42P01, counts a
failure, pauses for 30 seconds and retries after that. The migration is additive, so an existing
install keeps working while it is applied.

### 12.5 Phase 2A: sink and writer (one build session)

Branch per the task issue. TDD: each test is written first and observed failing as stated.

**Task 2A.1: Sanitizer in shared.** Files: packages/shared/src/log-sanitizer.ts,
packages/shared/src/index.ts, packages/ai/src/adapters/redact.ts (re-export),
tests/unit/log-sanitizer.test.ts. Tests:

1. URL credentials: `https://bob:hunter2@host/x` returns no `hunter2` and keeps `bob` and `host`.
   Fails on a broken build because the current function passes it through (Phase 0 verified).
2. Cookie and Set-Cookie header values and Basic and Digest Authorization values are masked. Fails
   if only Bearer is handled.
3. A nested error, `new Error("x", { cause: new Error("token=abc12345") })` inside a context object
   under key `err`, returns no `abc12345` at any depth, including inside an `errors` array. Fails if
   only top-level strings are scrubbed.
4. A key named `password` holding a short plain value is masked by key. Fails if only value shapes
   are checked.
5. A cyclic object terminates and the result is bounded. Fails with a hang or stack overflow.
6. A 10 MB message returns at most 2048 bytes with `truncated:true`, and a three-byte character is
   never split (use a string of 1,000 euro signs). Fails if the cut counts characters.
7. A sanitizer that throws drops the record (returns null) and never returns the raw input. Fails if
   a catch falls back to the raw record.
8. Every existing `redactSecrets` assertion (find them with the codebase graph) still passes through
   the re-export. Fails if the extension changed old behaviour.

**Task 2A.2: Migration.** Files: packages/settings/sql/<next number>\_diagnostic_log_records.sql,
tests/integration/diagnostic-log-store.test.ts. Verify the number per 12.4. Tests run through the
real runtime roles, not the migration owner:

1. The worker role inserts a row. Fails if the grant or policy is missing.
2. The app role cannot SELECT or DELETE the table directly (permission error). Fails if a grant
   leaked.
3. Admin A reads A's own row with full message, and another user's row as metadata only with
   `message` null. Observed failing with the owner comparison removed from the function.
4. An unowned row returns metadata only to every admin.
5. A non-admin gets no rows from the function. Observed failing with the admin check removed.
6. Table checks reject a message over 2048 bytes and a level of 30. Fails if the checks are absent.
7. Purge removes rows older than the age cap and trims to the row cap oldest-first, returns the
   count, and the app role cannot execute it. Fails on an off-by-one cap or a leaked grant.
8. Deleting a user deletes that user's rows (cascade).
9. Running the migration file twice changes nothing.

**Task 2A.3: Sink.** Files: packages/settings/src/diagnostic-log-sink.ts,
tests/unit/diagnostic-log-sink.test.ts (fake database handle), plus an integration case in
tests/integration/diagnostic-log-store.test.ts. Tests:

1. `enqueue` returns without awaiting. A database that never answers does not block it. Fails if the
   write is awaited in the call path.
2. A database that throws on every flush leaves `enqueue` silent, increments `failed`, and the next
   `enqueue` still works. Fails if an exception escapes.
3. Failure reporting never re-enters the logger (a fake logger fed by the sink sees zero calls
   caused by the sink's own failure). Fails with infinite recursion if unguarded.
4. A storm of 10,000 records in one minute stores at most 200 plus one `log.dropped` summary with the
   right count, and the queue never exceeds 500. Fails if either bound is missing.
5. A foreign-key failure (stale owner id) retries the batch with owners removed, and the rows land
   unowned. Fails if the batch is lost.
6. SQLSTATE 42P01 opens the 30-second pause and recovers after it (fake clock). Fails if it retries
   hot.
7. `close()` flushes what is queued once and then ignores later records.

**Task 2A.4: Destination and API wiring.** Files: packages/settings/src/diagnostic-log-destination.ts,
apps/api/src/recording-logger-options.ts, apps/api/src/server.ts (:267-269),
tests/unit/diagnostic-log-destination.test.ts, tests/unit/recording-logger-options.test.ts.

- `recordingLoggerOptions` gains an optional second argument `{ sink }`. With an object logger it
  sets `stream` to `createSanitizedLogDestination` wrapping the caller's stream (or stdout). With
  `false` it still returns `false`. A caller's serializers, redact policy and level survive.
- server.ts builds the sink from the worker-role handle that already exists (:254) and closes it
  in the server's close hook.
- Tests: (1) a line with `Authorization: Bearer xyz12345` reaches the destination stream already
  masked and the stored record is masked. Fails if either copy is raw. (2) `logger:false` writes
  nothing and builds no sink. (3) a custom caller stream still receives output. (4) a line below
  warn reaches stdout but not the sink. (5) a request that triggers a warning still returns its
  normal status when the sink database is down. Fails if a sink fault becomes a request error.

**Task 2A.5: Worker wiring and purge job.** Files: apps/worker/src/worker.ts (:206-211, reorder so
the database handle exists first, then the logger with the sanitizing destination),
apps/worker/package.json (add `@moss/shared` only if the worker imports it directly),
packages/settings/src/data-export-jobs.ts (:253), packages/settings/src/diagnostic-log-sink.ts,
tests/unit/worker-schedule-mode.test.ts (extend), tests/integration/diagnostic-log-purge.test.ts.

- Tests: (1) a worker-logger warning is stored with process `worker` and masked. (2) the purge
  queue is scheduled by the worker only (extend the existing schedule test; fails if the API
  process schedules it). (3) the purge job deletes aged rows through a real pg-boss run. (4) the
  purge payload holds only `{ kind }` (metadata-only invariant).

**Phase 2A verification** (unpiped, expect exit 0 each):

```bash
pnpm typecheck > /mnt/unity-nvme/scratch/phase2a-typecheck.log 2>&1; echo "EXIT=$?"
```

```bash
pnpm test:unit > /mnt/unity-nvme/scratch/phase2a-unit.log 2>&1; echo "EXIT=$?"
```

```bash
node_modules/.bin/tsx scripts/check-migration-collisions.ts > /mnt/unity-nvme/scratch/phase2a-collide.log 2>&1; echo "EXIT=$?"
```

The integration files and the full gate run only through the verify-gate skill. Add a script
`test:integration:3978-logs` next to `test:integration:3978` listing the new integration files.
2A ships as its own PR. Nothing reads the table yet, so it adds no visible behaviour. Ship it,
confirm rows appear on a dev instance after a real warning, then start 2B.

### 12.6 Phase 2B: reader, owner tagging, app map, two-process proof (one build session)

Depends on 2A merged and PR 3981 merged.

**Task 2B.0: Answer the two open questions in 12.1** and write the answers into this section.

**Task 2B.1: Owner binding.** Files: packages/module-registry/src/route-guard.ts (:320-323), the
worker job handler chosen in 2B.0, packages/settings/src/diagnostic-log-destination.ts
(`withLogOwner`), tests/unit.

- Bind the actor on the request logger after authentication resolves, and on the job logger inside
  the chosen worker handler from the job's actor id.
- Tests: (1) a warning logged in a request by user A is stored with A as owner. Fails if the binding
  is missing. (2) an invalid uuid in `actorUserId` stores null. (3) a request without
  authentication logs unowned.

**Task 2B.2: Reader.** Files: packages/settings/src/diagnostic-log-reader.ts (new, exported),
packages/module-registry/src/index.ts (inject next to `readJobs`, near :3953),
packages/ai/src/platform-diagnostics.ts, packages/module-sdk/src/platform-diagnostics-types.ts,
packages/settings/src/platform-diagnostics-tool.ts.

- `readDiagnosticLogs(scopedDb: DataContextDb, opts): Promise<LogsSection>` calls the two definer
  functions through the scoped handle (app role). It maps level numbers to names, cuts messages to
  500 characters, and caps the list at 10 and the section at 16 KB through the existing
  `capSection`.
- Tests (integration, each observed failing with its protection removed):
  1. A non-admin gets `logs` in `redactions`, an empty section, and the function was not called.
  2. A demoted admin is refused on the second call.
  3. Spoofed `isInstanceAdmin` or `actorUserId` in tool arguments is rejected.
  4. Admin A sees A's own warning text, and sees only metadata for B's warning and for an unowned
     warning, with `message:null`. Fails with the function's owner check removed.
  5. Filters: `minLevel:"error"` excludes warn rows, `component` narrows, `sinceMinutes` excludes
     old rows. Each fails if its filter is ignored.
  6. A record whose stored context holds `SECRET-MARKER` never returns that string (the reader
     returns no context at all). Fails if context is passed through.
  7. 50 matching rows return 10 and `truncated:true`. Fails if the cap is missing.
  8. `coverage` reports the oldest and newest times, and an empty store returns nulls so Moss can say
     "logs only go back to X" or "nothing is stored yet".
  9. Prompt guidance: the Phase 1 sentence (total under 150 words) grows by at most one clause that
     names logs. Fails if guidance exceeds the cap.

**Task 2B.3: App map.** Files: packages/settings/src/platform-diagnostics-features.ts. Add feature
`settings.platformDiagnostics.logs` (what it shows, admin only, warn and above, 7 days, 50,000 rows,
owner-visible text only, both processes, the sink may drop records under a storm), an error entry
`log_store_empty_or_gap` with a remediation, and rewrite the `limits` sentence so it no longer says
Moss cannot show log lines. State the owner-binding coverage found in 2B.0. Test: the app-map
coverage test passes, and a new assertion that these entries exist fails without them.

**Task 2B.4: Two-process live proof.** Files: tests/uat/3978-logs.uat.spec.ts (new), script
`test:uat:3978-logs` in package.json, following tests/uat/run-uat.ts and
tests/uat/real-chat-env.ts. Real instance, real chat, no faked or rewritten network responses.

1. Cause a real warning inside the worker process, owned by the admin, by the real path chosen in
   2B.0. The marker is a unique string present in the logged message and absent from the question.
2. Sign in as the admin and ask Moss in plain words why the connection failed. Assert the answer
   contains the marker, and that the conversation's recorded tool activity includes
   `settings.platformDiagnostics` with the `logs` section.
3. Cause a warning owned by a second user. Ask as the first admin. Assert the answer carries the time
   and component but not the second user's marker, and the returned record has `message:null`.
4. Sign in as a non-admin and ask the same. Assert a server-side `redactions` entry for `logs` and
   neither marker anywhere in the answer.
5. Restart the API and worker, ask again, and assert the first warning is still retrievable (the
   store survives a restart).
6. Assert the output of both processes contains no unmasked secret planted in the same warning (a
   fake token inside the logged error), proving the sanitizer ran before both destinations.

The test must fail if registration, the sanitizer, owner binding, the admin gate or the owner check
is broken. Run it and record the output on the PR (Live-Path Gate). Until that is attached the
honest status is code-complete, unverified.

**Phase 2B verification** (unpiped): the three commands in 2A, plus the live proof below
(expect exit 0), plus the full gate through verify-gate. CI's end-to-end step is listed separately
because the local gate excludes it.

```bash
pnpm test:uat:3978-logs > /mnt/unity-nvme/scratch/phase2b-uat.log 2>&1; echo "EXIT=$?"
```

### 12.7 Kill gate and sizing

- Owner: Ben. After 2B, run both Phase 0 faults again and then one fresh fault that jobs and
  connection state cannot explain. Phase 0 showed neither earlier fault needed raw logs, so this
  phase is judged on that third fault. If the store is empty or the fault left no warning at the
  moment it is needed, reopen the storage design before Phase 3 (section 8).
- Sizing: 2A is medium-large (sanitizer, migration, sink, two wirings). 2B is medium-large (reader,
  binding, app map, live proof). If a context warning arrives in 2A, cut after Task 2A.3 and ship
  tasks 2A.4 and 2A.5 as a second PR on the same branch. Relay at most once.
- Phase 3 is not planned here.

### 12.8 Rulings ledger additions

- The sanitizer lives in `@moss/shared`, not `@moss/ai` (settings cannot import it) and not a new
  package (one more workspace for a small module). `@moss/ai` re-exports it so old callers keep
  working.
- Reading the table directly from the app role was rejected. A function is the only way to return
  metadata for some rows and full text for others, because row policies cannot hide columns.
- Storing info-level lines was rejected. It is the storm level and no Phase 0 fault needed it.
- A debug route that emits a test warning was rejected. The proof must go through a real worker
  path.
- `ON DELETE CASCADE` on the owner is deliberate, so deleting a user removes that user's log text.

### 12.9 Decisions only Ben can make

1. Whether unowned system records (a worker warning with no user attached) stay metadata-only for
   admins, as ruled. An admin then sees "a warning at time T from component C" but not its text for
   most platform faults. The alternative is a separate instance scope, readable by admins and
   limited to records the platform itself produced. That is not a bypass of user data, but it is a
   classification change and needs his word. This plan builds the ruled version.
2. Retention numbers: 7 days, 50,000 rows, warn and above. Constants, so easy to change later.
3. Whether `app.readSource` becomes admin-only (Phase 3, unchanged).

### 12.10 Amendments after Codex review (2026-11-04)

This subsection overrides any conflicting text in 12.1 to 12.9. Where 12.5 and 12.6 name "2A" and
"2B", read them through the four-slice split in 12.10.1. The task bodies still apply, moved as shown.

#### 12.10.1 Four slices, one build session each

| Slice | Content                                                                                                                                               | Moved from            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 2A    | Sanitizer in shared, plus every error output path routed through it (12.10.2). No database.                                                           | 2A.1 and new          |
| 2B    | Database boundaries: table, read and coverage functions, grants, purge function and the hourly purge job. Tests for roles, admin check and the purge. | 2A.2, 2A.5 part       |
| 2C    | Sink (bounded queue, one flush at a time) and wiring in both processes, with the limits in 12.10.5.                                                   | 2A.3, 2A.4, 2A.5 part |
| 2D    | Reader section and tool input, owner binding in shared service loggers (12.10.3), allow-listed labels (12.10.4), app map, two-process live proof.     | 2B.0 to 2B.4          |

Each slice ships as its own PR and has its own unpiped verification block (the three commands in
12.5, plus the integration scripts named for that slice). 2D carries the live-path proof and the
kill gate. 2B and 2C may be built in either order, but both must merge before 2D.

#### 12.10.2 Error output that bypasses the logger (blocker 1)

The sanitizer must also cover the places that write errors without going through the process
logger. Seams, each verified on main:

- packages/jobs/src/pg-boss.ts:263-275 (`defaultOnPgBossError` writes `error.message` raw to
  stderr). Used by the API (apps/api/src/server.ts:252) and the worker (apps/worker/src/worker.ts:223).
- apps/worker/src/worker.ts:665-676 (crash handler: `console.error` of a JSON line holding the raw
  `err.message`; it already drops non-Error reasons to "unknown").
- apps/api/src/process-lifecycle.ts:39 (`createCrashHandler`, the API counterpart) and the API
  entry block at apps/api/src/server.ts:874-890 (crash hooks, `server.listen`).
- Startup and shutdown failures: the worker startup check around apps/worker/src/worker.ts:252
  (the "queues do not exist" error), the `bootstrap` function near :727, and both shutdown paths
  (worker.ts:697-701 and `shutdownOnSignal` in apps/api/src/process-lifecycle.ts).

Decision: every one of these calls `sanitizeLogText` on any message text before writing it. Crash
lines, startup failures and shutdown failures are also fed to the sink when it is available, with
the short bounded wait in 12.10.5, and are not dropped just because the process is exiting.
`@moss/jobs` gains a dependency on `@moss/shared` if it lacks one.

Tests, one per entry point, each observed failing against the unsanitized code:

1. `defaultOnPgBossError` given an error whose message holds `postgres://u:SECRET-CANARY@h/db`
   writes a line without the canary.
2. The worker crash handler given an `Error` whose message holds the canary logs a line without it.
3. The API crash handler, same.
4. A startup failure carrying a canary writes sanitized text in both processes.
5. A shutdown failure carrying a canary writes sanitized text in both processes.
6. A static check (unit test over the source tree) that no file under apps/api/src, apps/worker/src
   or packages/jobs/src writes `error.message` to stderr or `console.error` without calling the
   sanitizer. It fails when a new raw writer is added.

#### 12.10.3 Owner binding in shared service loggers (blocker 2)

A process-wide logger cannot know whose work it is doing. Decision: every logger handed to a
service that acts for a user is a child bound to `actorUserId` for that one request or job, and the
sanitizer treats only that top-level field as the owner (12.2). Concretely:

- API composition root: apps/api/src/server.ts:554 builds `createModuleLogger(server.log, "connectors")`
  once, shared by the OAuth and Google clients. That shared logger stays unowned. The OAuth
  callback, the Google connection and any other request-scoped call site obtain a per-request child
  through `withLogOwner(request.log, actorUserId)` after authentication and pass it down as that
  call's logger. The client classes take an optional per-call `logger` argument that defaults to the
  shared one.
- Connector sync: packages/connectors/src/sync-jobs.ts:663 passes `deps.logger` (shared) into the
  email extraction. `job.data.actorUserId` exists in the job. The sync entry builds
  `withLogOwner(deps.logger, job.data.actorUserId)` once per job and passes that child to every
  helper in the job. The auth-failure warning at :345 currently carries `actorScoped: true`. It uses
  the bound child instead, so the stored owner is the user's id, and the `actorScoped` field is
  removed.
- `createModuleLogger` returns a pino child, so `withLogOwner` is applied to that child, and the
  destination must still see `actorUserId` as a top-level field. Task 2D.0 verifies this with the
  real logger before any other 2D work.

Tests (2D), using warnings the services really emit, not a fake call:

1. The Google sync with a failing token fetch logs `google-sync auth failed`. The stored record has
   the user's id as owner and no `actorScoped` field. Fails against the current code.
2. The same warning for user B is not readable as text by admin A.
3. An OAuth callback failure for user A stores A as owner.
4. A call with no bound child logs unowned, never owned by a guessed user.
5. Two jobs for different users run concurrently and each stores its own owner (no cross-binding
   through the shared logger).

#### 12.10.4 Labels shown across owners (blocker 3)

Component, connection kind and event code are visible to admins on rows they do not own, so they
cannot carry free text. Decision: take them only from fixed allow-lists in `@moss/shared`
(`LOG_COMPONENTS`, `LOG_CONNECTION_KINDS`, `LOG_EVENT_CODES`, each a readonly string array exported
with a type). The sanitizer maps any value outside its list to `"other"` (component) or null (kind
and code) and never stores the original. Matching is by exact equality with no transformation, so a
private value that merely contains a list word does not pass. Message and context stay owner-only.

Tests (negative, each field):

1. A record whose component is `mail-for-alice@example.test` stores `other`. Same for kind and code.
2. A private marker placed in `component`, `connectionKind` and `eventCode` of user B's record never
   appears anywhere in the serialized section admin A receives.
3. Every component, kind and code used by a real emitter in the repo is on its list (a unit test
   greps the emitters). It fails when a label is added without a list entry.

Adding a label is a one-line change plus its test.

#### 12.10.5 Limits that bound the logging work (blocker 4)

All limits are constants in the sink or sanitizer, each with a test:

- One flush at a time per process. While a flush runs, records wait in the queue.
- Queue capped at 500 records and 512 KB serialized. When either cap is hit, the oldest queued
  records are dropped first, then new ones, and a counter feeds the one `log.dropped` summary per
  minute.
- Traversal bound applied before masking: the sanitizer stops at depth 6, 200 keys per object, 200
  items per array and 64 KB of visited text, then truncates, so a huge input never costs unbounded
  CPU. This bounds work, not only output.
- Database timeouts: each insert batch runs with a 3-second statement timeout and the flush has a
  5-second overall deadline. On deadline the batch is dropped and counted.
- Shutdown: `close()` waits at most 2 seconds for the final flush, then abandons it.
- Output stall: if the destination stream reports backpressure, records to the stream are dropped
  once its buffer reaches 256 KB, and the sink path continues on its own. The logger never blocks the
  event loop waiting on stdout.

Tests:

1. A database that never answers: 1,000 `enqueue` calls complete in under 50 ms, only one flush is
   running, the flush ends at its deadline, and `close()` returns within 2 seconds. Fails if flushes
   stack up or shutdown hangs.
2. A stalled output stream: the process keeps handling records, memory stays under the cap, and sink
   writes continue.
3. A 50 MB nested object is truncated within a fixed work bound (assert on visited-node count, not
   only on time). Fails if the traversal runs before the cap.
4. A cap hit drops by the stated rule and the summary count is exact.

#### 12.10.6 Caps are purge targets, not hard limits (non-blocker 5)

The 50,000-row and 7-day caps are targets enforced by the hourly purge job, not hard limits. At 200
records a minute per process and two processes, up to 24,000 records can arrive between purges, so
the table can briefly hold about 74,000 rows. The app-map entry and the 12.2 bounds bullet must say
this. Test: with 50,000 existing rows and 24,000 inserted, the reader still honours its own limit
of 50, and the purge brings the count back to 50,000 or fewer.

#### 12.10.7 Admin check and role tests (non-blockers 6 and 7)

- The read function body is written out in 12.3. Added tests: an active admin who is not the
  bootstrap owner reads rows (fails with a plain users-table check); a deactivated admin and a
  non-admin get nothing; a bootstrap owner who has been demoted is refused.
- The worker role cannot read or delete rows directly (permission errors) and cannot execute the
  read or coverage functions. The app role cannot insert. The API's writes use its existing
  worker-role handle at apps/api/src/server.ts:254.
- Live proof (2D) uses a separate canary secret per process: one planted in a real API warning and a
  different one planted in a real worker warning. The test then removes each sanitizer in turn (API
  destination, worker destination, stored copy, and each error path in 12.10.2) and must fail every
  time. It also asserts neither canary appears in process output, the table or the chat answer.

#### 12.10.8 Citation fixes (non-blocker 8)

Applied in place in 12.1, 12.4 and 12.5: API worker-role handle apps/api/src/server.ts:254, worker
database apps/worker/src/worker.ts:212, API entry scripts/start-jarv1s.ts:200, migration 0356 is
packages/ai/sql/0356_module_page_activity_surface.sql, and the manual next-number search covers
`packages/*/src/sql` as well (scripts/check-migration-collisions.ts:11). The builder re-runs the
number search against origin/main and open pull requests at the start of slice 2B.

### 12.11 Platform warning text (slice 2E, Ben's ruling 2026-11-05)

Ruling on 12.9 item 1: unowned records (no `owner_user_id`) show their message text to admins.
Records owned by another user stay metadata-only for admins. 12.9 item 2 stands (retention as
built). Item 3 is answered: the source reader is not admin-only (Phase 3 plans for that).

Decisions:

- **Classification.** `app.diagnostic_log_records` stays owner-or-unowned. Message text is returned
  when the row's owner is the caller, or when the row has no owner and the caller is a live admin.
  No admin exception for rows owned by someone else. No BYPASSRLS.
- **Change surface.** One new migration in `packages/settings/sql/` (next free number, checked
  against origin/main and open pull requests) that does `CREATE OR REPLACE FUNCTION
app.read_diagnostic_log` with the same signature and return columns. The `message` expression
  becomes `CASE WHEN r.owner_user_id = app.current_actor_user_id() OR r.owner_user_id IS NULL THEN
r.message END`. The admin check in WHERE is unchanged, so a non-admin still gets nothing. The
  applied migration 0357 is not edited.
- **Context.** The stored context JSON is still never selected. Only the cleaned message text is
  added.
- **Reader.** `packages/settings/src/diagnostic-log-reader.ts` stops gating message text on
  `owned` and returns whatever the function returned. `owned` and `ownerKnown` keep their meaning.
- **Secret cleaner.** Unchanged and already applied before storage. The new text exposure raises the
  stakes, so the secret-path tests are re-run against an unowned row and observed failing with the
  cleaner removed.
- **Known limit.** An unowned message can still hold private data a pattern cannot recognise (a
  mail subject inside an error). Mitigations stay the 7-day cap and the 2 KB cut. The app map says
  so.
- **Tool wording.** The `logs` tool description and the persona line stop saying unowned text is
  withheld. Guidance stays under 150 words.

Tests (behaviour, and why each fails against a broken build):

1. Admin A reads an unowned row with full text. Fails if the function still withholds it.
2. Admin A reads user B's owned row as metadata only. Fails if the new CASE drops the owner test.
3. A non-admin gets no rows at all, including unowned ones. Fails if the admin check moves.
4. An unowned row carrying a secret-shaped string comes back masked.
5. The two-process live proof (`pnpm test:uat:3978-logs`) gains one case: a platform warning with no
   user shows its text to the admin in a real chat turn, and a second user's warning still shows
   metadata only.

App map: update the logs feature declaration in the same PR. Release note: Category N/A (admin
diagnostics, not yet user-visible) unless the PR template says otherwise.

Then the kill gate (section 8) runs on the real faults.
