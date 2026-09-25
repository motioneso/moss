# Feature Health Alerts

**Status:** Draft, awaiting Ben's approval
**Date:** 2026-09-25
**Owner:** Ben
**GitHub:** issue #2683 (related #2689 / PR 2691)

---

## 1. Problem

A prod audit on 2026-09-25 found five features broken for weeks with nothing surfaced:

| Feature           | What happened                 | Why nobody saw it                                                                                    |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Background AI     | ~281k errors since 2026-08-07 | `generateText` and the worker AI bridge turn every error into `{ok:false}` with no record            |
| Job-match scoring | No scores since 2026-08-08    | `runScore` returns `halted`; the job completes normally and nothing stores or shows it               |
| Email commitments | Never produced an item        | The Google-sync gate skips at info level when AI is missing; judgement failures live only in pg-boss |
| Sports            | Empty, reported healthy       | An ESPN 200 with an unexpected shape parses to empty lists with `degraded: false`                    |
| Bank sync         | Never synced, reports success | `finance.sync-run` always returns `{status:"ok"}`; a failed connection only marks its own row        |

Three structural gaps sit behind all five:

- **No durable outcome record.** pg-boss keeps finished jobs for 60 s to 24 h per queue, so job
  history cannot answer "when did this last work?"
- **Success means "did not throw".** Each feature above catches its failure and completes.
- **Nothing reads the signals that do exist.** `ModuleDiagnosticProvider` has one implementation
  (news) and only the chat diagnostics tool reads it. Downloadable modules cannot provide one.

## 2. Goals

- Every periodic job, feed and expected output reports an honest outcome to one durable record.
- A daily check reads that record and pushes admins when something has been broken for a day.
- Status screens show the same honest state. One vocabulary, one source of truth.
- The CLI tool-update result (#2689) lands in the same record with no extra work.

Non-goals are in section 12.

## 3. Decisions

### 3.1 One health record, written by the features, read by everyone

A new core package, `packages/health`, owns a table of health signals. Features report into it
through a public API. The daily check, the admin screen and the per-feature badges all read it.
This keeps module isolation intact: nothing reads another module's tables to guess its health.

### 3.2 Reports carry codes and counts, never content

A report holds an outcome, a reason code from a fixed list, small integer counts and timestamps.
It has no free-text field. So it cannot carry a provider error body, a prompt, an email subject or
a secret, and it is safe to aggregate for admins (section 5.3).

### 3.3 Generic job coverage plus explicit feature reports

- **Generic.** Every scheduled queue gets a job signal for free. The worker registration wrapper
  reports `ok` when a handler returns and `failed` when it throws.
- **Explicit.** A handler that completes while failing (all five audit cases) reports its real
  outcome. An explicit report during a run overrides the wrapper's `ok`.

### 3.4 Alert on sustained breakage, not on single failures

A signal alerts only after it has been broken for 24 hours (section 6). A single failed run, a
retry, or a brief outage shows on the screen but never pushes.

### 3.5 Delivery through the notifications module

Alerts use the existing notifications path (`NotificationsRepository.create`, same as the
upgrade notice). That path sends Web Push to each device the person has enabled, and honours quiet
hours. Moss has no ntfy integration today; adding one is out of scope (section 12).

### 3.6 Ben's answers

Answered 2026-09-25:

- **Recipients:** every active instance admin, matching the CLI tool-update alerts.
- **Cadence:** push when something newly breaks, then remind every 3 days while it stays broken.
- **Channel:** the existing notifications push. No ntfy.

## 4. Signals

### 4.1 Signal kinds

| Kind     | Answers                                   | Example                        |
| -------- | ----------------------------------------- | ------------------------------ |
| `job`    | Did the periodic job succeed?             | `finance.sync-run`             |
| `feed`   | Did the feed serve live data or fallback? | Sports scores, news            |
| `output` | Is expected data still arriving?          | Job matches, email commitments |

### 4.2 Declaration

Signals are declared, so the admin screen can list a feature before its first report and the check
knows its thresholds.

- **Downloadable modules:** a new `health` array in `jarvis.module.json`, validated in
  `packages/module-registry/src/external/validate.ts`.
- **Built-in modules:** a `health` field on `MossModuleManifest` (`packages/module-sdk/src/index.ts`).
- **Core, non-module jobs:** a static list in `packages/health/src/core-signals.ts`.
- **Scheduled queues:** declared automatically from manifest `worker.schedules` and core
  `boss.schedule` calls, as `job` signals labelled with the queue name unless a declaration
  overrides the label.

```jsonc
"health": [
  {
    "id": "bank-sync",              // signal id becomes "finance.bank-sync"
    "label": "Bank sync",
    "kind": "job",
    "scope": "user",                // "user" | "instance"
    "queue": "finance.sync-run",    // links the generic job signal to this declaration
    "staleAfterHours": 36,          // optional; default 36, or 3x the schedule interval if longer
    "expectOutputWithinDays": 7,    // output kind only
    "href": "/finance"              // where the person fixes it
  }
]
```

### 4.3 Report shape

```ts
interface HealthReport {
  signalId: string; // declared id, namespaced by module
  outcome: "ok" | "idle" | "degraded" | "failed";
  reason?: HealthReasonCode; // required for degraded and failed
  produced?: number; // items produced this run (output kind)
  pending?: number; // input waiting to be processed (output kind)
}
```

- `idle` means nothing to do: the feature is not set up, or has zero connections. It never alerts.
- `degraded` means the feature served fallback or stale data.
- Reason codes (fixed, in `packages/shared/src/health-api.ts`): `needs_config`, `provider_error`,
  `usage_limited`, `timeout`, `bad_output`, `auth_expired`, `source_unreachable`,
  `source_changed`, `fallback_only`, `job_error`, `update_held_back`, `cannot_check_updates`.
  Adding a code is a code change with an app-map remediation (section 9).

### 4.4 Reporting API

- **Built-in packages:** `HealthReporter.report(scopedDb, report)` from `packages/health`, the
  public API.
- **Downloadable modules:** `ctx.health.report(report)` on `ModuleWorkerContext`, wired through the
  worker RPC host like `ctx.notify`. The host namespaces the id with the module id and rejects
  undeclared ids.
- **Coalescing.** A hot path (background AI, a request-driven feed) may report thousands of times a
  day. The reporter keeps the latest outcome per signal and person in memory and writes at most
  once a minute, adding the counts. A `failed` after an `ok` is written straight away so a streak
  start is never lost.

### 4.5 Failure reports must survive the rollback

A handler that throws rolls back its scoped transaction, and a report written inside it would roll
back too. The generic wrapper and explicit failure reports therefore write in their own
transaction, after the handler's transaction ends. `registerDataContextWorker` gains an
`onFailure` hook next to `afterCommit` for this.

## 5. Storage

### 5.1 Table

`app.feature_health_signals`, SQL in `packages/health/sql/`:

| Column              | Notes                                                   |
| ------------------- | ------------------------------------------------------- |
| `signal_id`         | e.g. `finance.bank-sync`                                |
| `owner_user_id`     | null for instance scope                                 |
| `last_outcome`      | latest outcome                                          |
| `last_reason`       | latest reason code                                      |
| `last_reported_at`  |                                                         |
| `last_ok_at`        | last `ok` or `idle`                                     |
| `broken_since`      | first non-ok report after the last ok; cleared on ok    |
| `last_output_at`    | last report with `produced > 0`                         |
| `pending`           | latest pending count                                    |
| `failures_today`    | rolling count for the tooltip; reset daily by the check |
| `first_reported_at` |                                                         |

Unique on `(signal_id, owner_user_id)` with `NULLS NOT DISTINCT`. One row per signal per person,
upserted, so the table stays small with no history to prune.

`app.feature_health_alerts` holds alert state per signal (section 6.4): `signal_id`,
`first_alerted_at`, `last_alerted_at`, `resolved_at`.

### 5.2 Row access

- User-scope rows are **owner-only**. A person sees their own feature health.
- Instance-scope rows are readable by instance admins.
- Writes go through the reporter only.

### 5.3 Admin rollup

Admins see instance-wide health through `app.list_feature_health_rollup()`, a `SECURITY DEFINER`
function gated on `is_instance_admin`, following `app.list_connector_account_safe_metadata()`.
It returns one row per signal with counts of people in each state, the oldest `broken_since` and
the most common reason. It returns no user ids. Admins learn "bank sync is failing for 1 of 2
people" and nothing about whose bank or what it holds. This is configuration-level metadata and
keeps the no-private-data-bypass invariant.

## 6. The daily check

### 6.1 Job

`health.daily-check`, a core scheduled job in the worker, once a day at 07:00 in the bootstrap
owner's profile time zone (UTC if unset). Payload is empty plus a date idempotency key. It reads
the rollup through the worker's system handle.

### 6.2 Verdicts

Each signal gets one verdict. The first rule that matches wins.

| Verdict       | Rule                                                                                 | Pushes |
| ------------- | ------------------------------------------------------------------------------------ | ------ |
| Stopped       | Reported before, but no report for `staleAfterHours` (the job no longer runs)        | yes    |
| Failing       | `broken_since` 24 h or older and latest outcome `failed`                             | yes    |
| Fallback only | `broken_since` 24 h or older and latest outcome `degraded`                           | yes    |
| No new data   | `output` kind, `pending > 0`, and no output for `expectOutputWithinDays` (default 3) | yes    |
| Shaky         | Broken for under 24 h                                                                | no     |
| Working       | Latest outcome `ok`                                                                  | no     |
| Not set up    | Latest outcome `idle`                                                                | no     |
| No data yet   | Declared, never reported                                                             | no     |

For a user-scope signal, the verdict is the worst verdict among people, and the count of affected
people is kept for the screen.

### 6.3 Recipients

Every active instance admin (section 3.6). Admins are read with the worker's system handle from
`app.users` where `is_instance_admin` and status is active.

### 6.4 Push rules

Per section 3.6:

- Push when a signal newly reaches a pushing verdict.
- While it stays broken, remind every 3 days.
- When it recovers, set `resolved_at` and send nothing.
- One notification per admin, not one per signal. It uses `moduleId: "health"` and
  `eventKey: "feature-health"`, so it updates in place rather than piling up.

The notification:

```
+------------------------------------------+
| Moss                                     |
| 2 features stopped working               |
| Bank sync, Background AI                 |
+------------------------------------------+
```

Tapping it opens Settings > Feature health. The body lists labels only, never reasons or counts.

### 6.5 CLI tools (#2689)

The CLI tool-update feature reports instance signals `ai.cli-tools.<provider>`:

| CLI tool state     | Report                           |
| ------------------ | -------------------------------- |
| `current`          | `ok`                             |
| `checking`         | no report                        |
| `held_back`        | `failed`, `update_held_back`     |
| `needs_newer_moss` | `degraded`, `update_held_back`   |
| `cannot_check`     | `failed`, `cannot_check_updates` |
| `not_installed`    | `idle`                           |

That feature already pushes its own alerts (#2689 section 7). Its declaration sets
`ownPush: true`, so the daily check lists it on the screen but does not push for it again.

## 7. Wiring the five audit cases

Each is a small change inside the owning module, using the API in section 4.4.

| Feature           | Signal                        | Change                                                                                                                                                                         |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background AI     | `ai.background` (user)        | `generateText` and the worker AI bridge report each result, coalesced. Error classes map to `needs_config`, `provider_error`, `usage_limited`, `timeout`, `bad_output`         |
| Job-match scoring | `job-search.scoring` (output) | The pass handler reports `failed` with the `halted` reason. `produced` is the scored count, `pending` the unscored postings                                                    |
| Email commitments | `commitments.email` (output)  | The sync gate reports `failed, needs_config` instead of an info log. The judgement worker reports each run. `pending` is threads awaiting judgement                            |
| Sports            | `sports.scores` (feed)        | `DatasetClient` reports `degraded, fallback_only` on fallback. The ESPN parser reports `degraded, source_changed` when a 200 lacks the expected fields, instead of empty lists |
| Bank sync         | `finance.bank-sync` (job)     | The sync handler reports `ok` if at least one connection synced, `failed` with `auth_expired` or `provider_error` if none did, and `idle` with zero connections                |

`DatasetClient` reports for every caller that passes a signal id, so news gets the same treatment.
The chat and notes commitment extractor also stops advancing `last_run_at` on a failed run.

## 8. What people see

### 8.1 Admin screen: Settings > Feature health

A new admin section, `/settings?section=health`, in the Operations group above Connector
oversight. One row per declared signal, worst first. Each row shows a label, one badge, a people
count for user-scope signals, and a link to the feature. The reason shows as the badge tooltip.

```
Feature health                                       Checked 07:00

  Bank sync            [ Failing 21d ]      1 of 2 people     Open
  Background AI        [ Failing 49d ]      3 of 3 people     Open
  Job-match scoring    [ No new data 48d ]  1 of 1 person     Open
  Sports scores        [ Fallback 3d ]      2 of 3 people     Open
  Claude CLI           [ 2.1.290 held back ]                  Open
  Email commitments    [ Shaky ]            1 of 2 people     Open
  News                 Working
  Tasks recurrence     Working
  Notes sync           Not set up
```

| Verdict       | Badge text            | Tone  |
| ------------- | --------------------- | ----- |
| Stopped       | "Stopped 2d"          | red   |
| Failing       | "Failing 21d"         | red   |
| Fallback only | "Fallback 3d"         | amber |
| No new data   | "No new data 48d"     | amber |
| Shaky         | "Shaky"               | amber |
| Working       | none, plain "Working" | none  |
| Not set up    | none, muted text      | none  |
| No data yet   | none, muted text      | none  |

Tooltips come from the fixed reason list: "The AI provider returned errors", "No AI model is set
up", "Usage limit reached", "Timed out", "The AI returned unusable answers", "Sign-in expired",
"Can't reach the source", "The source changed its format", "Only saved data available", "The job
crashed", "Update held back", "Can't check for updates".

Rules: `@moss/ui` `Badge` with its existing tones (`red`, `amber`), the reason in an `InfoTip`,
plain rows in a `Card`. No new components, no callouts. The design-system skill applies at build.

### 8.2 Honest states on existing screens

Each person sees their own state on the feature's own screen, read from their own rows.

- **Finance feed.** The connection badge shows sync age from `lastSyncAt`: "Synced 3h ago", or an
  amber "Not synced 21d". "Connected" alone no longer shows while syncs fail.
- **Job search.** The header gets one amber badge, "Scoring stopped", while `job-search.scoring`
  is broken. The tooltip gives the reason.
- **Sports.** The existing degraded banner stays. It now also appears for `source_changed`.
- **Connector oversight.** No change. It already shows per-account sync state.

```
Finance                               Job search
  Everyday account  [ Not synced 21d ]   Matches  [ Scoring stopped ]
```

### 8.3 API

- `GET /api/admin/health`, admin-only, returns the rollup plus `checkedAt`.
- `GET /api/health/mine` returns the caller's own rows for the feature screens.
- Types in `packages/shared/src/health-api.ts`. Routes declared in the `health` package manifest.

## 9. App map

In the same PRs as the screens:

- `CORE_APP_SETTINGS`: a `health` entry, "Feature health", admin scope, describing the rows,
  badges and links.
- `CORE_APP_REMEDIATIONS`: one entry per reason code, e.g. `needs_config` points to
  Settings > AI providers and `auth_expired` points to the feature's reconnect screen.
- Finance and job-search manifests: update their `features` text for the new badges.

## 10. Security and invariants

- No free text in reports, so no content, prompts or secrets reach the table, the push or the admin
  screen.
- Admins get counts only, through a definer function gated on `is_instance_admin`. No
  `BYPASSRLS`.
- `health.daily-check` payload is a date key only.
- No new setting or environment variable. Thresholds are declared in code. Ben's rule against
  hand-edited settings files holds.

## 11. Slice plan

| Slice | Content                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------- |
| 1     | `packages/health`: table, reporter, declarations, generic job wrapper with `onFailure`, SDK `ctx.health` |
| 2     | Daily check, push, admin screen, API, app map                                                            |
| 3     | Audit cases: background AI, bank sync, finance badge                                                     |
| 4     | Audit cases: job scoring, email commitments, sports and `DatasetClient`, job-search badge                |
| 5     | CLI tools signal. Lands with #2689 slice that writes the check result, whichever merges second           |

Slices 1 and 2 share a PR. Each later slice needs live proof on dev that the broken case shows
and pushes: force the failure, run the check by hand, see the push and the badge.

## 12. Out of scope

- ntfy, Telegram or other delivery channels. Messaging channels have their own spec (2026-09-14).
- A history of past incidents or charts.
- Letting Moss answer "is anything broken?" in chat. The chat diagnostics tool can read this record
  in a follow-up.
- Self-healing or automatic retries beyond what jobs already do.
- Per-person alert settings beyond the existing notification mute and quiet hours.
