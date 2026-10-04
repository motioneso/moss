# Plan: one activity history that says what Moss did (#2956)

- Spec: `docs/superpowers/specs/2026-10-03-activity-history.md` (approved, merged in #2955).
- Issue: #2956. Section 11 (shadow report) is out of scope here; lane #2957 builds it.
- Risk tier: security. Opus adversarial review follows; every privacy claim below names the
  test that fails without it.
- Branch: `feat-2956-activity-history`. One PR for all four slices.
- Slices: A (storage + recording + schedule + integration tests), B (writers + coverage
  guard), C (page lines + dialog + layout, live UI proof), D (filters + retire old page +
  app map, live UI proof). This session plans all four, builds A only.

## 0. Seams check (verified on this branch before planning)

- `recordModelActivity` takes only kind, action, outcome, modelName, result
  (`packages/ai/src/model-activity.ts:17-24`). No owner, duration, tokens, or turn link.
  Spec premise holds.
- Table `app.moss_model_activity_log` exists with exactly six recorded columns, admin-only
  SELECT, append-only (`packages/ai/sql/0254_moss_model_activity_log.sql:18-64`). Spec
  premise holds.
- Action audit log has `request_id` and `chat_session_id` but no turn column
  (`packages/ai/sql/0127_jarvis_action_audit_log.sql:12-13`). Spec premise holds: the
  `turn_id` column is genuinely missing and slice A adds it.
- Shadow records already key turns by `turn_id`
  (`packages/chat/src/classifier-shadow-repository.ts:89`), and the live gate threads a
  `turnId` through (`packages/chat/src/live/classifier-gate-shadow.ts:32`). One value
  across shadow record, audit row, and activity line is achievable; slice A task 6 confirms
  the exact value before wiring.
- Migration numbers (renumbered 2026-10-03 on rebase): `origin/main` holds 0256
  (proactive monitoring) and 0257 is reserved for the focus history purge lane (#2637).
  New files take 0258 and 0259; re-check `origin/main` before every push.
- DRIFT FOUND (not a re-scope, resolved here): spec section 5.6 says to follow the 0251
  purge function, but 0255 deleted that function and #2911 retired its queue
  (`packages/chat/src/jobs.ts:74-76`). The live pattern is the audit-log purge queue
  (`packages/ai/src/jobs.ts:10-35`: `boss.schedule` with `0 3 * * *` UTC, worker calls a
  no-argument fixed-retention function). Slice A follows that pattern, not 0251.
- OPEN: the audit-log purge cutoff in 0127 as amended by #2682 (spec section 5.7 asks to
  confirm it). Slice A task 1 reads it; the Activity page shows 90 days and the plan
  assumes 90 days unless the code says otherwise.
- Writers for slice B confirmed to exist: HTTP API adapter records through
  `withModelActivityRecording` (`packages/ai/src/adapters/http-api.ts:54-93`); the
  classifier lives in `packages/ai/src/structured/generate-choices.ts`; chat turn state
  lives in `packages/chat/src/live/chat-session-manager.ts`. Slice B re-verifies exact
  call sites with a call-site search before editing (spec section 4 ruling).
- UI seams for slices C/D confirmed: `Dialog` primitive exists
  (`packages/ui/src/dialog.tsx`); `Menu` closes on each pick
  (`packages/ui/src/menu.tsx`), so the model checklist is genuinely a new primitive;
  panes are `apps/web/src/settings/settings-activity-pane.tsx` (206 lines) and
  `apps/web/src/settings/settings-model-activity-pane.tsx` (296 lines); app-map entries
  are `activity` and `modelactivity` (`packages/shared/src/app-map-core.ts:136,327`).
- Guard test for slice B: `tests/unit/model-call-coverage.test.ts` (727 lines), plus the
  integration log test `tests/integration/ai-model-activity-log.test.ts` and the catalog
  entry `tests/integration/foundation-schema-catalog.test.ts:530-531`.

## 1. Determinism boundary (applies to slices C and D)

- Every line, sub-line, badge, and dialog fact renders from recorded columns only. No
  extra model call ever summarises or titles a line (spec ruling 6).
- Titles are a fixed vocabulary in code keyed by action code; structured-call titles come
  from the calling module manifest. Sub-lines are templates over recorded facts.
- Failure sentences come from the failure-code table (spec section 5.4), never from raw
  provider text.
- No module injects turns into host chat through this feature. Guidance budget: none;
  no new model prompt is added by any slice.

## 2. Slice A: storage, purge schedule, recording API, integration tests

### DDL decision (migration 0258, `packages/ai/sql/0258_activity_owner_lines.sql`)

Bare line `app.moss_model_activity_log` gains nullable columns: `owner_user_id` uuid
(FK `app.users`, on delete cascade), `action_code` text (CHECK non-blank, max 64),
`turn_id` text (CHECK max 128), `parent_id` uuid (plain column, NO foreign key: the chat
answer line is written at turn end, after its steps, so a FK would force deferred
constraints through a fire-and-forget writer; the list query tolerates a missing parent),
`duration_ms` integer (CHECK >= 0), `input_tokens` / `output_tokens` integer
(CHECK >= 0, null when the provider does not report), `failure_code` text
(CHECK in the eight-code allow list in spec section 5.4), `fact_counts` jsonb
(CHECK `pg_column_size` under 512 bytes; a code-level JSON schema admits numbers and
booleans only). Existing columns (`kind`, `action`, `outcome`, `model_name`, `result`)
stay untouched so old readers keep working until slice B lands.

Order inside the migration: `DELETE FROM app.moss_model_activity_log` FIRST (spec ruling
9: pre-release rows have no owner and must not become System lines), then add columns,
then replace policies. The detail table is created after the delete so nothing cascades.

Row security, same migration: drop the admin read policy. New SELECT:
current actor set AND (`owner_user_id` = actor, OR (`owner_user_id` IS NULL AND actor is
admin)). INSERT WITH CHECK: actor set AND (`owner_user_id` = actor OR `owner_user_id`
IS NULL). No UPDATE, no DELETE policy on the bare table: still append-only, kept
forever.

### DDL decision (same migration 0258, detail table)

`app.moss_activity_detail`: `activity_id` uuid PK (FK to the log, on delete cascade),
`owner_user_id` uuid NOT NULL (FK `app.users`, on delete cascade; CHECK equals the
line's owner enforced by trigger), `quote` text (CHECK `octet_length` <= 2000),
`result_line` text (CHECK char length <= 500), `steps` jsonb NOT NULL
(CHECK `pg_column_size` under 8192 bytes), `created_at` timestamptz default now(),
`expires_at` timestamptz NOT NULL default `created_at + interval '30 days'`.
FORCE ROW LEVEL SECURITY. SELECT, INSERT, UPDATE owner-only (same expression as 0251
used: actor set AND owner = actor). No admin policy. UPDATE trigger rejects changes to
`owner_user_id` and `expires_at`. Reads filter `expires_at > now()` in the repository,
not in policy, so the purge and the page agree.

### DDL decision (migration 0259, `packages/ai/sql/0259_audit_log_turn_id.sql`)

Action audit log gains `turn_id` text null (CHECK max 128), plus an index on
`(turn_id)` for the per-turn join. No policy change.

### Purge decision (migration 0258, function + schedule)

`app.purge_expired_moss_activity_detail()`: SECURITY DEFINER, no arguments, deletes
detail rows with `expires_at <= now()`, returns the count. EXECUTE to
`jarvis_worker_runtime` only. New queue `ai-purge-activity-detail` in
`packages/ai/src/jobs.ts` beside `AI_PURGE_AUDIT_LOG_QUEUE`: daily
`boss.schedule(..., "0 3 * * *", {}, { tz: "UTC" })`, worker calls
`AiRepository.purgeExpiredActivityDetail(rootDb)`. Payload carries nothing private.

### API decisions (`packages/ai/src/model-activity.ts`, `packages/ai/src/repository.ts`)

- `ModelActivityEntry` gains optional `id`, `ownerUserId`, `actionCode`, `turnId`,
  `parentId`, `durationMs`, `inputTokens`, `outputTokens`, `failureCode`,
  `factCounts` (typed as numbers/booleans only), and `detail`
  (`{ quote, resultLine, steps }`). All optional; old callers compile unchanged.
- `recordModelActivity` stays fire-and-forget. When `detail` is present it is written
  inside the owner's data context so the owner-only insert check passes; ownerless lines
  never write a detail row.
- New `attachModelActivityFacts(id, facts)`: owner-only detail update for facts that
  settle late (Jev agreement). Cannot change owner or expiry.
- `withModelActivityRecording` measures duration itself; existing result words stay as
  the fallback.
- New failure-code mapper: provider error to one of the eight codes; raw error text is
  never stored (dropped at the boundary, not truncated).
- `boundModelActivityEntry` extends clamping to the new text fields (action code 64,
  turn id 128, quote 2000 bytes, result line 500 chars).

### Slice A test cases (integration, via the verify-gate skill on an isolated gate DB)

1. Old rows vanish: seed a 0254-shaped row, run 0258, the bare table is empty. Fails if
   the DELETE runs after the column add or is omitted.
2. Owner sees own lines only: two users plus an admin; each sees exactly their rows.
   Fails without the owner-only SELECT.
3. Admin sees System lines and nothing else: null-owner rows visible to admin, invisible
   to non-admins. Fails if the admin branch leaks owned rows or hides System rows.
4. No cross-owner insert: inserting a row owned by someone else fails. Fails with a
   permissive WITH CHECK.
5. Bare table still append-only: UPDATE and DELETE as app role fail. Fails if a policy
   is added by accident.
6. Detail expiry: an expired detail row is invisible to the list query and the purge
   function deletes it; unexpired rows survive. Fails without the `expires_at` filter
   or the purge.
7. Detail update cannot change owner or expiry: both attempts fail. Fails without the
   trigger.
8. `fact_counts` rejects text: inserting `{"note":"hello"}` fails at the CHECK or the
   code schema. Fails if text can reach the bare line.
9. Unknown `failure_code` fails at the CHECK. Fails without the allow list.
10. Purge EXECUTE is worker-only: app role gets permission denied. Fails with a wide
    grant.
11. Recorder writes through: `recordModelActivity` with owner plus detail produces one
    bare row and one detail row under the owner's context. Fails if the detail write
    runs outside owner context.
12. Existing catalog test updated: `foundation-schema-catalog` gains the 0258/0259
    entries; the old `ai-model-activity-log` expectations for admin-wide read are
    rewritten to owner-only.
13. Schedule registered: worker boot registers `ai-purge-activity-detail` with a daily
    cron (unit test on `registerAiMaintenanceWorkers` with a fake boss).

### Slice A verification (each unpiped, expected exit 0)

- `pnpm verify:foundation > /tmp/vf-a.log 2>&1; echo "EXIT=$?"`
- `pnpm vitest run packages/ai/src/model-activity.test.ts > /tmp/unit-a.log 2>&1; echo "EXIT=$?"`
- Gate-DB integration suite per the verify-gate skill (never a raw DB-touching run).

### Slice A e2e

The integration suite above, observed passing on the isolated gate database, IS the
slice A e2e (no UI surface yet). Record the output.

## 3. Slice B: writers fill the new fields, coverage guard updated

Tasks: call-site search re-verifying the spec section 4 writer list; chat turn
(`packages/chat/src/live/chat-session-manager.ts` and turn lifecycle) picks the answer
line id at turn start and writes it at turn end; Jev check
(`packages/ai/src/structured/generate-choices.ts`) records `chat.tool_check` with
confidence and agreement facts; HTTP API + CLI structured adapters
(`packages/ai/src/adapters/http-api.ts`, `http-api-structured.ts`, CLI multiplexer)
record `structured.<service>` with duration/tokens/failure code; embeddings
(`packages/memory`), transcription, provider probes, background tasks, and module
builds record their action codes; audit rows carry the turn id so the list query joins
steps to turns; `tests/unit/model-call-coverage.test.ts` allow-lists updated for every
touched file. Unit tests per writer: the new fields land with the right values, and a
writer with no owner still records a bare ownerless-safe row that slice A policies
accept. Verification: `pnpm vitest run <touched>`, foundation gate, coverage guard
green. E2E: one chat turn in a dev instance produces an answer line with steps joined
by turn id (DB read, not UI yet).

## 4. Slice C: page lines, detail dialog, layout (needs live UI proof)

Tasks: Activity page (`apps/web/src/settings/settings-activity-pane.tsx`) renders
Muse-style lines from bare columns plus unexpired detail (title vocabulary,
quote/result/steps, meta, badges, day grouping, chat-answer grouping by `parent_id`
with audit steps joined on `turn_id`); detail dialog on the `Dialog` primitive with
step list-box, per-step facts, failure sentences, and expiry note; full-width layout
per spec section 8 with the 44px phone minimums and the minimum-gap spacing table;
new UAT spec `tests/uat/specs/2956-activity-history.uat.spec.ts` plus a row in
`.claude/skills/coordinate/uat-trigger-map.tsv`; Playwright run on the live dev
instance. Verification: unit + gate + `pnpm playwright:test` for the touched specs.
E2E: the UAT run, observed passing, plus a `gh pr comment` with live proof. No faked
network responses, ever.

## 5. Slice D: filters, retire old page, app map (needs live UI proof)

Tasks: model checklist primitive (`packages/ui/src/`, `.jds-checklist` classes from
the mockup) with counts, "No model (tool only)", Tick all/Done, phone sheet layout;
filter bar order (time range, module, Models button, hidden-count note, Reset filters),
8px wrap gap, no result filter; local-storage persistence keyed by user id storing
UNTICKED models; Reset filters visibility rule; System module-filter option for
admins; old admin Model activity page
(`apps/web/src/settings/settings-model-activity-pane.tsx`) retired and its route
removed; app-map `activity` entry rewritten and `modelactivity` entry plus settings
section removed (`packages/shared/src/app-map-core.ts:136,327`); structured-service
titles declared in owning module manifests. Verification: unit + gate + Playwright for
the touched specs; full `pnpm verify:foundation`. E2E: UAT rows covering filter
persistence and reset, observed passing, plus live proof comment.

## 6. Kill gate (owner: coordinator, after slice A)

Slice A ships alone and is judged before slice B is built. End the line if the
integration suite shows owner-only policy cannot hold the required shapes (for
example the late-attaching Jev agreement cannot land without an UPDATE the
append-only rule forbids, or the turn-start id cannot survive fire-and-forget
recording). In that case the coordinator re-slices; no slice B work starts.

## 7. Rulings ledger

- 0251 is the wrong purge exemplar: 0255 deleted its function and #2911 retired its
  queue (`packages/chat/src/jobs.ts:74-76`). Follow `AI_PURGE_AUDIT_LOG_QUEUE`
  (`packages/ai/src/jobs.ts:10-35`). Fact about the tree, verified 2026-10-03.
- `parent_id` is a plain uuid with no FK: the answer line is written after its steps,
  so a FK would need deferred constraints inside a fire-and-forget writer. Decision,
  taken in this plan; revisit only if orphan steps appear in slice B e2e.
- New migrations are 0258/0259; re-check `origin/main` before every push.
  Collision rule, not a decision.

## Review checklist

- [x] Spec approved (`docs/superpowers/specs/2026-10-03-activity-history.md`) and task
      issue open (#2956)
- [x] Every assumed capability cited `file:line`, or listed as an open question
      (one open: audit-log purge cutoff, owner: slice A task 1)
- [x] No function bodies; signatures, DDL, and test cases only
- [x] Determinism boundary stated; no new model prompt, so the 150-word budget is moot
- [x] Each slice names its e2e test
- [x] Every verification command unpiped, with an expected exit code
- [x] Kill gate named, with an owner (coordinator, after slice A)
- [x] Steelmanned the rejected option (deferred FK vs plain uuid, section 7)
