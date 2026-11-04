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
