# Moss heartbeat — Phase 1 build plan

Part of #3752. Builds the approved [Moss heartbeat spec](../specs/2026-10-25-moss-heartbeat.md) and
its approved [mockups](../specs/mockups/moss-heartbeat/README.md) (Ben, 2026-10-28). The spec is
the behavior contract; this plan records decisions, boundaries, contracts and proofs. It holds no
function bodies. Phase 1 ends at the kill gate below; Phase 2 is not planned in detail.

Seams were checked against `origin/main` at `449e8ff47`. Every builder refreshes the citations
they rely on before writing code and records any drift in the ledger at the end.

## Verified seams

| Capability                                | Current evidence                                                                                                                             | Decision                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Scoped enqueue and worker context         | `packages/jobs/src/pg-boss.ts:197` (`sendJob`), `:404` (`registerDataContextWorker`); cron is worker-only `:279`                             | Reuse. Payloads carry owner ID, occurrence ID, settings version and idempotency key only.                                   |
| Owner enumeration without RLS bypass      | `packages/connectors/sql/0144_google_sync_sweep_accounts.sql:27` (SECURITY DEFINER, worker grant, IDs only)                                  | Same pattern for a new `app.list_heartbeat_due_owners()`; returns owner IDs only.                                           |
| Global sweep cron that fans out           | `packages/connectors/src/google-sync-sweep.ts:28`, `:76`                                                                                     | One heartbeat sweep cron enqueues one singleton beat job per due owner. No per-owner pg-boss cron.                          |
| Versioned run, retry bound, quiet outcome | `packages/chat/src/scheduled-reads/runner.ts:42`, `:64`, `:136`, `:174`                                                                      | Copy the lifecycle shape, not the code path. A beat is a system responsibility, never a forged scheduled read.              |
| Main thread                               | `packages/chat/src/repository.ts:475` (`getMainThread`), `:490` (`ensureMainThread`)                                                         | Publish only to the owner's Main.                                                                                           |
| Code-written assistant turn with origin   | `packages/chat/src/repository.ts:422`; `packages/chat/src/reminders/deliver.ts:139`; origin type `packages/shared/src/chat-api.ts:324`       | Add a `ChatHeartbeatOriginV1` origin kind. Do not call the reminder helper; extract only shared insert/arrival behavior.    |
| Notification identity and dedupe          | `packages/notifications/src/repository.ts:51-60`, `:367`                                                                                     | `moduleId: "chat"`, `eventKey: heartbeat:<occurrenceId>`. Urgency is always `normal`.                                       |
| Quiet hours and allowance hook            | `packages/notifications/src/push-worker.ts:358`, `:374-387`; `packages/notifications/src/repository.ts:19`                                   | Heartbeat allowance policy rechecks off/suppression/expiry at dispatch and never grants a quiet-hours exception.            |
| Provider-routed structured generation     | `packages/chat/src/scheduled-reads/report-generation.ts:40`, `:52-56`                                                                        | Same resolver, capability `json`, tier `economy`. No provider or model name in code.                                        |
| Background source reads                   | `packages/ai/src/gateway/gateway.ts:567-571` (only `tasks.get`); hook `packages/module-sdk/src/index.ts:681`; check `gateway.ts:621`, `:790` | Widen to a named allowlist of heartbeat read tools, each with `authorizeBackgroundRead`. This is the one new platform seam. |
| Calendar change signal                    | `packages/calendar/sql/0011_calendar_module.sql:16` (`updated_at`); bounded read `packages/calendar/src/manifest.ts:343`                     | New bounded read returns max `updated_at` as revision. No sync cursor exists.                                               |
| Tasks change signal                       | `packages/tasks/sql/0003_tasks_module.sql:24`; background-authorized `packages/tasks/src/manifest.ts:517-530`                                | New bounded read alongside `tasks.get`.                                                                                     |
| Remembered commitments (Memory source)    | `packages/commitments/sql/0125_commitment_candidates.sql:8-15`, `:31`, `:44`; `packages/commitments/src/repository.ts:242`                   | Accepted candidates with `due_local_date` are the Memory source in V1. Semantic retrieval is not used for the pre-check.    |
| News stories                              | Slice 2 owner checks the news module's cached read and manifest at build time                                                                | New bounded read of cached stories only, same contract as the other sources.                                                |
| Sports next fixture                       | `packages/sports/src/followed-card.ts:332`; `packages/sports/src/sports-service.ts:1594`, `:988`                                             | New read returns each followed team's next verified fixture, built on `nextMatchAcross`. Cached data only.                  |
| Thumbs rating storage                     | `packages/shared/src/usefulness-feedback-api.ts:39` (`chat_message` record-only kinds); UI `apps/web/src/chat/message-row.tsx:251`           | Reuse. Thumbs up records `more_like_this`, thumbs down `not_useful`. No new table.                                          |
| Scheduled jobs list and stop              | `packages/chat/src/reminders/routes.ts:40-61`, `:74`; `apps/web/src/settings/settings-scheduled-tasks-pane.tsx`                              | Reuse the list and DELETE routes for the Scheduled jobs column. No new API.                                                 |
| Preference compare-and-set                | `packages/proactive-monitoring/src/preferences-repository.ts:69`, `:98`                                                                      | Same revision pattern on a separate heartbeat settings row.                                                                 |
| Legacy proactive-off                      | same repository                                                                                                                              | Read once at enrollment to seed explicit saved-off. Never write it.                                                         |
| Alerts pane and quiet hours               | `apps/web/src/settings/settings-alerts-pane.tsx:18`, `:130`; `packages/settings/src/quiet-hours-application.ts:7`                            | Add the check-ins card and status columns to this pane. Quiet hours stay owned by Settings.                                 |
| App map                                   | `packages/shared/src/app-map-core.ts:55`, `:188-189`                                                                                         | Settings declarations go here; chat and source features go in their manifests.                                              |
| Migrations                                | Global sequence `docs/operations/dev-environment.md:115`; collision check `scripts/check-migration-collisions.ts:12`                         | Highest at `449e8ff47` is `0341`. Take the next free number at landing time, not at plan time.                              |

## Design forks, ranked

1. **Where the heartbeat lives.** Chosen: inside `packages/chat` as `src/heartbeat/`, beside
   `reminders/` and `scheduled-reads/`. Chat already owns Main, code-written turns, the
   notification job and the scheduled-tasks routes. Rejected: a new `@moss/heartbeat` module. It
   would own its code more cleanly, but publication into Main and the reminder notification job
   are chat internals with no public port, so a new module needs a new cross-module publication
   seam before it can do anything. Revisit only if `packages/chat` file-size checks fail.
2. **How sources are read.** Chosen: one bounded read tool per source module, declared in the
   owning manifest with `authorizeBackgroundRead`, called through the gateway's background path.
   That keeps module isolation and owner checks inside each module. Rejected: chat importing
   calendar, sports and commitments services directly. It is faster to write, but it bypasses the
   gateway's per-call owner authorization and widens chat's imports into two more modules.
3. **How beats are scheduled.** Chosen: one worker cron sweep every 5 minutes that asks a
   SECURITY DEFINER function for due owner IDs, then enqueues a singleton beat per owner. It
   enrolls owners who never open Settings with no login hook. Rejected: per-owner self-
   rescheduling jobs like reminders. That needs a separate enrollment pass anyway and loses
   owners whose chain breaks.
4. **Where ratings live.** Chosen: reuse usefulness feedback on `chat_message`. Rejected: a
   heartbeat rating table, which duplicates storage, undo and the feedback list.

An adversarial second opinion on forks 1-3 is recommended before slice 3 starts, not required.

## Determinism boundary

- Settings acknowledgements, status, last-check results, muted topics and scheduled jobs render
  from saved records.
- Each item card in a heartbeat message renders its title, time and source from the evidence
  record. The model supplies only a short intro and one note per item.
- The Muted pill, Undo and the three choice chips render from the mute command's result record.
- The heartbeat writes a code-authored assistant turn in Main. It never injects a user turn and
  never runs inside a live chat turn.
- The model has exactly two jobs: **select which supplied items warrant attention now**, and
  **write one grounded intro plus one note per selected item**. An empty selection is valid.
- Guidance stays under 150 words. If it needs more, the bounded view or validator is wrong.
- Model output crossing into user data has all four guards: schema field descriptions, a prompt
  contract with one worked example, the boundary validator below, and per-item acceptance against
  the item's evidence record before commit.

## Contracts

### Shared types — `packages/shared/src/heartbeat-api.ts` (slice 1)

```ts
export type HeartbeatSource = "calendar" | "tasks" | "memory" | "sports" | "news";
export type HeartbeatCadenceMinutes = 30 | 60;

export interface HeartbeatSettings {
  readonly enabled: boolean;
  readonly cadenceMinutes: HeartbeatCadenceMinutes;
  readonly sources: Readonly<Record<HeartbeatSource, boolean>>;
  readonly revision: number;
  readonly origin: "default" | "saved" | "legacy_off";
}

export type HeartbeatOutcomeKind =
  | "never"
  | "quiet"
  | "message"
  | "held_allowance"
  | "degraded"
  | "failed"
  | "off";

export interface HeartbeatStatus {
  readonly lastCheckedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly outcome: HeartbeatOutcomeKind;
  readonly unavailableSources: readonly HeartbeatSource[];
  readonly recent: readonly {
    readonly at: string;
    readonly outcome: HeartbeatOutcomeKind;
    readonly itemCount: number;
  }[];
}

export interface HeartbeatMute {
  readonly id: string;
  readonly label: string;
  readonly scope: "item" | "topic";
  readonly createdAt: string;
}
```

Routes (chat manifest, owner-only): `GET/PUT /api/me/heartbeat/settings` (PUT carries
`expectedRevision`; 409 on conflict returns the saved record), `GET /api/me/heartbeat/status`,
`GET /api/me/heartbeat/mutes`, `DELETE /api/me/heartbeat/mutes/:id`.

### Source read contract — `packages/shared/src/heartbeat-source-api.ts` (slice 2)

```ts
export interface HeartbeatSourceReadInput {
  readonly horizonHours: number; // bounded, max 48
  readonly limit: number; // max 20
}

export interface HeartbeatEvidenceItem {
  readonly entityKey: string; // owner-scoped opaque key, stable across rewording
  readonly episodeKey: string; // changes only on a new material occurrence
  readonly title: string;
  readonly at: string | null; // ISO time or local date
  readonly kind: string; // e.g. "task_due", "event", "commitment_due", "fixture"
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

export interface HeartbeatSourceRead {
  readonly source: HeartbeatSource;
  readonly revision: string; // cheap material revision, e.g. max updated_at plus count
  readonly nextBoundaryAt: string | null;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly truncated: boolean;
  readonly items: readonly HeartbeatEvidenceItem[];
}
```

Tools, each `risk: "read"`, with `authorizeBackgroundRead`, declared in the owning manifest:
`calendar.heartbeatWindow`, `tasks.heartbeatWindow`, `commitments.heartbeatOpen`,
`sports.heartbeatNextFixtures`, `news.heartbeatStories`. The gateway's background method changes to:

```ts
runBackgroundReadForActor(
  actorUserId: string,
  read: { readonly operation: string; readonly input: Record<string, unknown>; readonly runId: string }
): Promise<GatewayToolResponse>;
```

with an explicit allowlist constant naming `tasks.get` plus the five tools above. The scheduled-
reads caller moves to `{ operation: "tasks.get", input: { taskId } }`.

### Message origin — `packages/shared/src/chat-api.ts` (slice 3)

```ts
export interface ChatHeartbeatOriginV1 {
  readonly version: 1;
  readonly kind: "heartbeat";
  readonly occurrenceId: string;
  readonly items: readonly {
    readonly findingId: string;
    readonly source: HeartbeatSource;
    readonly title: string;
    readonly at: string | null;
    readonly note: string;
  }[];
  readonly intro: string;
}
```

Slice 4 renders from this shape only. Fix it in slice 3's first commit so slice 4 can build in
parallel.

### Model boundary (slice 3)

Request: the selected bounded items (title, kind, at, facts, finding ID) plus owner local time.
Response schema:

```ts
interface HeartbeatModelResult {
  readonly selected: readonly { readonly findingId: string; readonly note: string }[];
  readonly intro: string | null;
}
```

Validator rejects the whole result when any `findingId` was not supplied, a note exceeds 280
characters, the intro exceeds 200 characters, or a note mentions a time, date or number absent
from that item's facts. A rejected result counts as a failed attempt against the allowance.

### Storage — chat module migration (slice 1)

One file in `packages/chat/sql/`, numbered at landing. Every table has `owner_user_id`, FORCE RLS
with an owner-only policy, `ON DELETE CASCADE` from `app.users`, and joins owner export/deletion.

```sql
CREATE TABLE app.heartbeat_settings (
  owner_user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  cadence_minutes smallint NOT NULL CHECK (cadence_minutes IN (30, 60)),
  sources jsonb NOT NULL,
  origin text NOT NULL CHECK (origin IN ('default', 'saved', 'legacy_off')),
  revision integer NOT NULL DEFAULT 1,
  next_due_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.heartbeat_source_checkpoints (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  revision text NOT NULL,
  next_boundary_at timestamptz,
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, source)
);

CREATE TABLE app.heartbeat_occurrences (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  settings_revision integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text NOT NULL,
  item_count smallint NOT NULL DEFAULT 0,
  message_id uuid,
  input_tokens integer,
  output_tokens integer
);
CREATE INDEX heartbeat_occurrences_owner_started ON app.heartbeat_occurrences (owner_user_id, started_at DESC);

CREATE TABLE app.heartbeat_findings (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  entity_key text NOT NULL,
  episode_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('selected', 'published', 'resolved', 'suppressed')),
  occurrence_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_user_id, source, entity_key, episode_key)
);

CREATE TABLE app.heartbeat_mutes (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('item', 'topic')),
  source text,
  entity_key text,
  topic text,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.heartbeat_allowance_charges (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  occurrence_id uuid NOT NULL,
  attempt smallint NOT NULL,
  PRIMARY KEY (owner_user_id, local_date, occurrence_id, attempt)
);

-- Owner IDs only. Owners with no settings row are due (default on); disabled owners are not.
CREATE FUNCTION app.list_heartbeat_due_owners(p_limit integer)
RETURNS TABLE("ownerUserId" uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$ /* active users LEFT JOIN heartbeat_settings WHERE row missing OR (enabled AND next_due_at <= now()) ORDER BY id LIMIT p_limit */ $$;
REVOKE ALL ON FUNCTION app.list_heartbeat_due_owners(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_heartbeat_due_owners(integer) TO jarvis_worker_runtime;
```

The function body is the builder's to write; the comment states its contract. Active means
`app.users.status = 'active'` (`infra/postgres/migrations/0050_multi_user_accounts.sql:13-14`).

## Shipped defaults

- On, every hour, all five sources on when authorized. Heartbeat findings do not count against the 8/day unsolicited-finding ceiling.
- Generation allowance: 6 attempts per local day, 8,000 input and 800 output tokens, 60 seconds.
  Constants in `packages/chat/src/heartbeat/limits.ts`. No env var, no settings file.
- Sweep cadence: every 5 minutes, at most 200 owners per sweep.
- No operational emergency stop in Phase 1. Chat is a required module, so module enablement
  cannot switch the heartbeat off. The owner's off switch is the stop, and Ben is the only
  install. Revisit before a wider rollout.

## Deployment config rule

No slice adds a required env var or config key. Defaults live in code and the owner changes them
in Settings. If a builder finds one is needed, the same PR adds it to `infra/docker-compose.yml`,
`infra/docker-compose.prod.yml` and `infra/env.production.example`, and asks the coordinator
first, because the spec forbids a hand-edited setting for this feature.

## Slices

Four slices, three PRs. Each lists the files it owns; a slice touches nothing outside its list
without asking the coordinator.

### Slice 1 — Settings, storage and enrollment (one worktree, one PR, two sessions)

**1a backend.** Owns `packages/chat/sql/<next>_chat_heartbeat.sql`,
`packages/chat/src/heartbeat/{settings-repository,settings-routes,status-repository,mute-repository,enrollment,sweep,beat-job,limits}.ts`,
`packages/shared/src/heartbeat-api.ts`, heartbeat route and worker registration in
`packages/chat/src/manifest.ts` and the chat worker registration file, and owner export/deletion
hooks.

- Sweep enqueues one singleton beat per due owner. In this slice the beat claims the
  occurrence, creates default settings for an owner with none (seeding `legacy_off` from a saved
  proactive master-off), records `never` → `quiet` with no source reads and no model, and sets
  `next_due_at`.
- Settings PUT is compare-and-set. Turning off clears `next_due_at`; frequency change replaces it.

**1b Settings UI.** Owns `apps/web/src/settings/settings-heartbeat-card.tsx`,
`apps/web/src/settings/settings-heartbeat-status.tsx`, the mount point in
`apps/web/src/settings/settings-alerts-pane.tsx`, client calls in `apps/web/src/api/client.ts`,
and `packages/shared/src/app-map-core.ts`.

- Builds mockup set 1 (`alerts.html`) and set 2 (`checkins.html`) states with `@moss/ui`
  components. Scheduled jobs column reuses the existing list and DELETE routes.
- Source switches show unavailable sources from `status.unavailableSources`; in this slice all
  five report available because nothing reads them yet. Slice 3 makes that real.
- App map: Settings declarations for check-in on/off, frequency, source switches, timezone
  dependency, muted topics and scheduled jobs with Stop, plus load/save/conflict errors.

Tests (behavior, and why a broken build fails them):

- Owner with no row and never visiting Settings gets a settings row and a `quiet` outcome after
  one sweep. Fails if enrollment depends on a login or Settings visit.
- Saved legacy proactive master-off yields `enabled: false, origin: "legacy_off"`. Fails if the
  default overwrites a saved opt-out.
- Two owners plus an admin cannot read or change each other's settings, status or mutes. Observe
  it fail with the RLS policy removed; record that in the PR.
- Stale `expectedRevision` returns 409 with the saved record; the UI keeps the draft.
- Off between sweep and beat: the beat exits with no outcome row change beyond `off`.
- Job payload inspection holds owner ID, occurrence ID, revision and key only.

Live proof: on an isolated dev instance, a fresh owner opens Alerts & quiet hours and sees
on/hourly; turns it off, saves, reloads; edits in two tabs and sees the conflict; status shows
`never` then a quiet check after the sweep; stops a real scheduled job from the column.

### Slice 2 — Source reads (own worktree and PR; parallel with slice 1)

Owns `packages/shared/src/heartbeat-source-api.ts`, `packages/ai/src/gateway/gateway.ts`
(background method and allowlist only), the scheduled-reads caller of that method,
and one new read tool plus its `authorizeBackgroundRead` in each of `packages/calendar/src/`,
`packages/tasks/src/`, `packages/commitments/src/`, `packages/sports/src/` and the news module's
`src/` (tool file and manifest tool entry only).

- Each tool is bounded by the contract limits, reads only cached/local data, and reports
  `freshness`. Sports reads cached fixtures; it never calls ESPN from a beat.
- No migration expected. If an index is needed, take the next number at landing and run the
  collision check.
- No user-visible change, so no app-map change and no live UI proof in this slice. Slice 3
  declares the features once a user can see them.

Tests:

- Each tool returns the same `revision` for unchanged rows and a different one after a material
  edit. Fails if the revision includes the current time.
- Background call for another owner's data is refused by `authorizeBackgroundRead`. Observe it
  fail with the check removed.
- A tool not on the allowlist is refused on the background path even if it declares the hook.
- `tasks.get` scheduled reads still pass unchanged.
- Limits cap at 20 items and set `truncated`.

### Slice 3 — Beat pipeline and publication (own worktree and PR; after slices 1 and 2)

Owns `packages/chat/src/heartbeat/{precheck,collect,filter,allowance,generation,validator,publish,notify}.ts`,
`beat-job.ts` (extending slice 1's), `ChatHeartbeatOriginV1` in `packages/shared/src/chat-api.ts`,
a heartbeat allowance policy registered with notifications, and the app-map feature metadata in
`packages/chat/src/manifest.ts` and the five source manifests.

First commit: the origin type, so slice 4 can start.

Pipeline follows spec steps 1-7. Decisions:

- Pre-check compares each source's `revision` and `nextBoundaryAt` with its checkpoint. No change
  and no crossed boundary → `quiet`, no model call.
- Filter drops resolved, muted, already-published and already-reminded items before the model.
- Allowance is reserved in the same transaction as the attempt; a held owner records
  `held_allowance` and keeps checkpoints unadvanced.
- Publish commits message, finding states, occurrence outcome and notification intent in one
  transaction. After commit, a retry only reconciles delivery.
- Notification uses `urgency: "normal"`; the allowance policy cancels the push if the owner turned
  off, muted every item, or every item expired, and rebuilds the push text from what remains.
- A source read failure marks that source unavailable in status and never advances its checkpoint.

Tests (model doubles at the provider boundary):

- Unchanged sources → zero generation calls across ten beats.
- A task entering its due window with unchanged rows → one call.
- Reworded model output for an already-published finding → no second message.
- Muted item → never sent; mute during generation → not published.
- Seventh attempt on a local day → `held_allowance`, no call. DST and timezone change do not
  refill.
- Quiet hours hold the push; release sends one summary; a model asking for urgency cannot bypass.
- Source text containing instructions cannot add a recipient, write or tool.
- Validator rejects an unknown finding ID and a note with an unsupported time.
- Revoking calendar access mid-run → no calendar item published.

Live proof: real owner on an isolated dev instance with a real AI configuration (CLI
subscription, cheapest model). Create a task due tomorrow, an accepted commitment, a calendar
event and a followed team through their real screens; wait for a scheduled beat; assert one Main
message with the expected items by message ID; next beat stays quiet; set quiet hours to now and
assert the push is held, then released. Record calls and tokens per beat.

### Slice 4 — Main message, stop topic and Notifications (own worktree and PR; build after slice 1 merges and slice 3's first commit; prove after slice 3 merges)

Owns `apps/web/src/chat/heartbeat-message.tsx`, the render branch in
`apps/web/src/chat/message-row.tsx`, `packages/chat/src/heartbeat/mute-command.ts` and its tool
entry in `packages/chat/src/manifest.ts`, and the held badge in the Notifications page component.

- Renders mockup set 3 (`main.html`) from `ChatHeartbeatOriginV1`: side-by-side item cards, intro,
  thumbs up and down always visible (usefulness feedback, `chat_message` target).
- Stop topic: the normal chat turn calls `chat.heartbeatMute` with a finding ID or a phrase. One
  match saves the mute and returns the record; the reply shows a Muted pill and Undo. Several
  matches return up to three candidates, shown as choice chips. Nothing is saved until one is
  picked.
- Renders mockup set 4 (`notifications.html`): held badge, released summary, expired and
  cancelled rows, from notification records.
- App map: chat features for heartbeat messages, stop/undo and rating; notification metadata for
  the held state.

Tests:

- Mute persists before the reply renders; Undo removes it and does not replay old items.
- Ambiguous phrase saves nothing and returns candidates.
- Thumbs click records the right kind; second click undoes.
- A live reply in progress and an arriving heartbeat message both survive reconnect.

Live proof: on the slice 3 instance, rate a real heartbeat message, stop a topic by typing "stop
telling me about <team>", reload Settings and see the mute, Undo it, and see the held badge on the
Notifications page during quiet hours.

## Order and parallelism

| Slice | Starts after                                | Runs alongside |
| ----- | ------------------------------------------- | -------------- |
| 1     | now                                         | 2              |
| 2     | now                                         | 1              |
| 3     | 1 and 2 merged                              | 4 (build only) |
| 4     | 1 merged and slice 3's origin commit pushed | 3              |

Default-on publication is reachable only once slice 3 merges, and slice 1's controls are already
in main by then. Slice 4 must merge before Ben's evaluation run.

## Verification for every slice

Scoped checks while building (expected exit 0 each):

```bash
npx tsc --noEmit > /tmp/tsc.log 2>&1; echo "TSC=$?"
npx eslint <files touched> --max-warnings=0 > /tmp/lint.log 2>&1; echo "LINT=$?"
```

Before the PR (each expected exit 0, run separately, never piped):

```bash
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/size.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
pnpm check:design-tokens > /tmp/tokens.log 2>&1; echo "EXIT=$?"   # slices 1 and 4
pnpm check:ui-classes > /tmp/ui.log 2>&1; echo "EXIT=$?"          # slices 1 and 4
```

Full gate through the `verify-gate` skill only (expected exit 0):

```bash
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow    # run_in_background; the exit code is the verdict
```

Browser suite for slices 1 and 4, which the local gate excludes (expected exit 0):

```bash
pnpm test:e2e <new heartbeat spec file> > /tmp/e2e.log 2>&1; echo "EXIT=$?"
```

Live proof goes on the PR as a comment with the commit, commands, exit codes, assertions and the
real-data setup and cleanup. No screenshots, no intercepted responses. Claim a dev port with
`devports claim <agent-name>` and release it after. A queued push is not proof of device
receipt; say so if receipt is not observed.

## Kill gate

Owner: Ben. After all four slices merge, the heartbeat runs on Ben's install. Report per day:
beats, generation calls, tokens, share of beats that skipped generation, messages, and thumbs
up/down. Stop and ask Ben to fix, rescope or cancel if any of these happens:

- an item repeats or a muted item appears;
- a push breaks quiet hours or reaches another owner;
- thumbs-down ratings or call counts are more than Ben will accept (his judgment, no threshold).

Phase 2 is planned only after that ruling. Candidates: News as a fifth source (open question 1 in
the spec), chat-created recurring jobs beyond today's scheduled reads, fixture-relative triggers,
and an operational emergency stop.

## Open questions

- **News in V1**: resolved by Ben on 2026-10-28. News is the fifth source. Slice 3 keeps heartbeat
  findings out of the 8/day unsolicited-finding ceiling.
- **Commitments as the Memory source** (slice 2 builder): confirm accepted candidates with a due
  date cover the timecard example in the spec. If they do not, stop and report rather than
  reaching for semantic retrieval in the pre-check.

## Seam ledger

- `packages/chat/src/scheduled-reads/runner.ts` citations in the spec (`:59`, `:128`, `:164`)
  moved to `:42`, `:64`, `:136`, `:174` by `449e8ff47`.
- Notifications have no kind field; identity is module plus event key
  (`packages/notifications/src/repository.ts:51-60`).
- Feature flags resolve from manifest defaults only, with no runtime override
  (`packages/module-registry/src/index.ts:3857-3863`), so they cannot serve as a kill switch.
- `news.topHeadlinesToday` exists (`packages/news/src/manifest.ts:367`) but is not background-
  authorized. Relevant only if Ben adds News.
- `app.list_all_users()` is granted to the app runtime, not the worker
  (`infra/postgres/migrations/0050_multi_user_accounts.sql:86-110`), so it is not the enrollment
  path.
