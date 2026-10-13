# #3138: repeating useful Tasks checks

Parent #3096. Build from integration/scheduled-proactive at `8c4b1aff5`.
The approved scheduled/proactive spec and #3138 define this bounded vertical slice.
Coordinator approved this plan and assigned new migration `0321` on 2026-10-13.
No applied SQL is edited. No new source adapter, scheduler, condition watch or write authority.

## Current seams and decisions

- `scheduled-reads/runner.ts:44-67` reloads owner, lifecycle, version, due time,
  deadline and source operation under the responsibility lock. `:70-94` uses
  the actual actor read gateway and caps quiet read retries at two.
- `scheduled-reads/runner.ts:101-128` rechecks lifecycle and source before
  publishing a configured-model report. The model remains outside transactions.
- `reminders/repeating.ts:19-47` computes one future saved-cadence occurrence;
  interval minimum is 60 seconds. Existing daily/weekly DST policy is reused.
- `reminders/runs.ts:7-27` persists one immutable occurrence/version;
  `:69-87` advances with a new reserved result identity. SQL 0319 currently
  permits advancement only after a delivered run and explicitly refuses read
  recurrence. Both guards must change in new SQL.
- `reminders/commands/save.ts:18-40` enforces the existing 20 queued/paused
  reminder/check limit and atomically creates the exact source plus metadata job.
  Briefings keep their existing independent schedule ownership; this slice does
  not create another briefing schedule or change their bounds.
- `reminders/settings.ts:55-112` currently maps any failed read to terminal
  failure. Repeating checks will keep active/paused lifecycle independently of
  latest execution outcome and expose actionable last-check guidance.

The approved spec requires useful new information, unchanged suppression,
quiet bounded retries, honest repeated failures and one fresh check after downtime.
The following bounded Tasks-source policies were expressly approved by the
coordinator; they are implementation decisions, not extra spec quotations:

1. The first valid read establishes a quiet baseline. The saving confirmation
   explains that only subsequent title/status changes will be reported.
2. Exact task ID, title and status define observation identity. Other source
   fields, timestamps and model wording cannot create novelty. A digest over
   that exact semantic tuple avoids storing an extra private source snapshot.
3. A valid quiet run resets the failure streak. A completed failed/refused run
   increments it; transient per-run retries do not. Notify once when a streak
   reaches three, then record honest quiet failures without flooding. A valid
   read resets the streak and permits a later independent failure episode.
4. A source changed between reads is failure, not a new observation. A failed
   report never advances the observation baseline, so the change remains due.
5. The existing exact task source stays immutable. Recurrence edits become
   supported through existing timing edits; source/text edits remain refused.

## Contracts and writable seams

- Extend `ScheduledReadPlan.when` with the existing validated RepeatRequest.
  Model job 1 selects one owned candidate and returns bounded timing terms;
  deterministic recognizers reject unsupported timing and source mutations.
- `scheduled-reads/observation.ts`: deterministic source identity and change /
  baseline decision; no source interpretation or model-generated novelty.
- `scheduled-reads/recurring.ts`: commit quiet/failure runs and cadence under
  the same lock, or delegate a real message to existing result persistence.
- `ScheduledReadRunnerDeps.boss` provides recurrence enqueue. In deliver.ts,
  add only optional runOutcome override so a posted failure is recorded as a
  failure; preserve fixed-reminder behavior and notification/result separation.
- Expand immutable run outcomes to delivered, quiet, failed, refused, expired.
  Message identity is present only for real posted results. Source report
  history retains its trusted Tasks rendering marker.
- Add optional checkFailure guidance to ScheduledTaskDto and the real response
  schema; render an authored Note without changing lifecycle controls.
- Add chat SQL `0321_chat_repeating_reads.sql`: observation_key, failure_streak
  and worker-only update grants; remove one-time-read guards; expand immutable
  run checks/RLS and worker advancement validation for read occurrences. Keep
  owner-only RLS, immutable exact operation/source, due/version identity and
  metadata-only queue payloads.
- Writable source: scheduled-reads request/generation/runner/repository and new
  observation/recurring helpers; reminders scheduled-read command, runs,
  deliver, edit, settings and features; DB types, shared scheduled API and
  authored Settings status. Scoped tests, UAT trigger map and this plan.

## Determinism and trust boundary

Saving feedback, quiet success, failure guidance and cadence come from stored
records and deterministic code. The model has exactly two jobs: interpret the
owner request and summarize an already authorized changed task. Both existing
schemas/prompts/validators remain bounded. Outside source titles never grant
operations, recipients, permissions or interruption exceptions. Each quiet or
reporting run performs a second actual source read and final lifecycle/version
lock. Concurrent/replayed jobs can publish at most one occurrence. Cancellation,
pause, deadline and stale versions win before observation or publication.

## Tests and gate

First write failing observation/request/history unit tests. Then implement and
run the exact scoped units. Integration covers baseline, unchanged, real title
and status novelty, reporting failure preserving identity, transient retries,
streak threshold/reset/no flood, source revocation, source changes, cross-owner
access, concurrent/replayed work, edit/pause/delete and downtime/cadence. Observe
security assertions failing after enforcement is removed, then restore it.
Update the directly obsolete one-time guards in #3151 integration and only the
affected #3136 UAT section. Keep fixed reminder regression checks intact.

- Scoped vitest unit invocation: expected exit 0.
- Root `pnpm typecheck`, scoped eslint and prettier: expected exit 0.
- `scripts/run-gate.sh start --gate test:integration:3138`, then its exact
  `wait --follow`: expected exit 0. This gate uses a throwaway DB only.
- Full `scripts/run-gate.sh start`, then exact `wait --follow`: expected exit 0.
- Fresh independent review on final bytes; repository static and browser checks
  are separate from full DB gate and must be reported accurately.

## Live proof and stopping condition

`tests/uat/specs/3138-repeating-useful-checks-real.uat.spec.ts` uses the real
isolated installed UI/worker, configured model and real owned Tasks item. Create
an every-60-second check in chat, inspect Settings, observe quiet baseline,
change the real task through UI, observe one sourced normal message, then an
unchanged quiet run. Stop only that isolated worker for multiple intervals,
resume it and assert one fresh quiet check followed by saved cadence. Exercise
phone/desktop, light/dark/Teal through DOM assertions, with no screenshots or
rewritten network responses. Delete the disposable check and tear down.

Kill gate: coordinator stops or reslices if this needs a new source/gateway,
unsafe migration authority or unrelated scheduler redesign. Missing Docker or
proof access is a verification blocker, not permission to bypass isolation.
Without full gate, independent review and real UI proof the honest outcome is
code-complete, unverified, and no merge. Publication remains root-owned.

## Rulings ledger

- 2026-10-13: coordinator approved baseline, title/status identity, streak-three
  policy, lifecycle-independent failure guidance, SQL 0321 and narrow deliver
  runOutcome override. #3137 acceptance ruling treats retry/exhaustion as
  automated coverage; its actual live demo passed. Webmail remains whole-3154
  acceptance or explicitly not exercisable when no account/source exists.
