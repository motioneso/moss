# Build plan — medication start dates, reminder toggle, editable schedules (#1968)

Spec: `docs/specs/1968.md`. Issue: #1968 (piece 1 of 4, re-sliced from #1965).
Risk tier: security. Scope: database and server only.

## Seams check — every assumption cited on this branch

| Assumption | Evidence |
| --- | --- |
| A start date is blocked for four of six types | `packages/wellness/sql/0194_wellness_medication_schedule_v2.sql:104` constraint `medications_v2_fields_scoped_to_v2_types` |
| The route mirrors that block for `as_needed` | `packages/wellness/src/routes.ts:736-757` (`startDate`/`endDate` in the rejected-field list) |
| No reminder column exists | absent from `app.medications` (0083, 0194) and from `MedicationsTable`, `packages/db/src/types.ts:790-818` |
| No reminder worker exists to break | `packages/wellness/src/manifest.ts:224-229` — queue name declared, comment says no worker registered |
| A saved schedule cannot be edited | `packages/shared/src/wellness-api.ts:655-665` (`updateMedicationRequestSchema`) and `packages/wellness/src/repository.ts:198-217` |
| PATCH does not resolve a time zone today | `packages/wellness/src/routes.ts:252-268` — no `resolveRouteTimeZone` call, unlike POST at `:241` |
| The schedule engine already gates on a start and end date | `packages/wellness/src/occurrence-engine.ts:133-151` |
| A cycle schedule's phase is counted from its anchor, so the anchor must not be repurposed | `packages/wellness/src/occurrence-engine.ts:232-236` (`isEligibleCycle` counts elapsed days from `anchor.startDate`) |
| `computeSchedule` is always called for exactly one day | `packages/wellness/src/schedule.ts:38` |
| Row-level security already scopes updates to the owner | `packages/wellness/sql/0083_wellness_medications.sql:66-72`, and every route runs inside `withDataContext` |
| Next free migration number is 0196 | highest existing is `0195_module_builds_worker_runtime.sql` |

Open questions: none. No net-new platform capability is assumed; every change is to code that
already exists.

## Determinism boundary

Not applicable in the usual sense — this piece adds no user-facing surface and no model
involvement. Nothing here renders anything or calls a model. The related boundary that does apply:
the server is the last line of validation, and every rule it enforces is also enforced by a
database check, so a bad write from any path is rejected.

## Design fork considered and rejected

**Rejected: feed `schedule_start_date` into the schedule engine's anchor for every family.**
Steelmanned: it is one line, it reuses the engine's existing start/end gating, and for the two new
types the start date already *is* the anchor. Rejected because for a cycle schedule the anchor is
`cycle_anchor_date` and it decides which days are "on" days
(`packages/wellness/src/occurrence-engine.ts:232-236`); swapping in a different date silently
shifts the whole on/off pattern. **Chosen instead:** a day-level window check in `computeSchedule`,
which leaves every family's repeat maths exactly as it is.

**Rejected: allow a partial schedule edit** (send just `intervalCount`, keep the rest). Rejected
because a leftover column from the previous schedule type would trip a database check and surface
as a 500. **Chosen instead:** an edit that touches the schedule must carry the whole schedule and
is validated by the same code as a create.

## Tasks

Each task commits green.

### Task 1 — migration and database types

`packages/wellness/sql/0196_wellness_medication_start_date_reminders.sql` (additive, re-runnable):

```sql
ALTER TABLE app.medications
  ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_v2_fields_scoped_to_v2_types;
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_v2_shape_fields_scoped_to_v2_types;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_v2_shape_fields_scoped_to_v2_types
    CHECK (frequency_type IN ('every_interval', 'monthly')
      OR (interval_unit IS NULL AND interval_count IS NULL AND month_kind IS NULL
          AND month_day IS NULL AND month_day_is_last IS FALSE
          AND month_weekday_position IS NULL AND month_weekday IS NULL));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_as_needed_no_reminders;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_as_needed_no_reminders
    CHECK (frequency_type <> 'as_needed' OR reminders_enabled IS FALSE);
```

`packages/db/src/types.ts`, `MedicationsTable`: add
`reminders_enabled: ColumnType<boolean, boolean | undefined, boolean>`.

Verify: `pnpm --filter @moss/db typecheck > /tmp/t1.log 2>&1; echo "EXIT=$?"` → expect `EXIT=0`.

### Task 2 — shared contract

`packages/shared/src/wellness-api.ts`:
- `MedicationDto`: add `readonly remindersEnabled: boolean`.
- `medicationDtoSchema`: add `remindersEnabled` to `required` and to `properties`.
- `createMedicationRequestSchema.properties`: add
  `remindersEnabled: { anyOf: [{ type: "boolean" }, { type: "null" }] }`.
- `updateMedicationRequestSchema.properties`: add `frequencyType`, `remindersEnabled`, and the
  same schedule properties `createMedicationRequestSchema` already declares, with identical
  ranges. `additionalProperties` stays `false`.

Verify: `pnpm --filter @moss/shared typecheck > /tmp/t2.log 2>&1; echo "EXIT=$?"` → `EXIT=0`.

### Task 3 — repository

`packages/wellness/src/repository.ts`:

```ts
export interface MedicationScheduleInput {
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay?: number | null;
  readonly intervalHours?: number | null;
  readonly weekdays?: readonly number[] | null;
  readonly scheduleTimes?: readonly string[] | null;
  readonly cycleDaysOn?: number | null;
  readonly cycleDaysOff?: number | null;
  readonly cycleAnchorDate?: string | null;
  readonly intervalUnit?: "days" | "weeks" | "months" | null;
  readonly intervalCount?: number | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly monthKind?: "date" | "weekdayPosition" | null;
  readonly monthDay?: number | null;
  readonly monthDayIsLast?: boolean | null;
  readonly monthWeekdayPosition?: "first" | "second" | "third" | "fourth" | "last" | null;
  readonly monthWeekday?: number | null;
  readonly remindersEnabled?: boolean | null;
}

export interface CreateMedicationInput extends MedicationScheduleInput {
  readonly name: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly notes?: string | null;
}

export interface UpdateMedicationInput {
  readonly name?: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly active?: boolean;
  readonly notes?: string | null;
  readonly remindersEnabled?: boolean;
  readonly schedule?: MedicationScheduleInput;
}

async updateMedication(
  scopedDb: DataContextDb,
  id: string,
  input: UpdateMedicationInput,
  timeZone: string
): Promise<Medication | undefined>
```

Behaviour decisions:
- `createMedication` also writes `reminders_enabled` (default false when omitted).
- When `input.schedule` is present, `updateMedication` writes every schedule column, setting the
  ones that do not apply to the new type to NULL and `month_day_is_last` to false, and refreshes
  `time_zone`.
- When absent, the update touches only the non-schedule fields, as today.
- One shared private helper builds the schedule column values so create and update cannot drift.

### Task 4 — route validation

`packages/wellness/src/routes.ts`:

```ts
function parseMedicationScheduleBody(value: Record<string, unknown>): MedicationScheduleInput
function parseCreateMedicationBody(body: unknown): CreateMedicationInput
function parseUpdateMedicationBody(body: unknown): UpdateMedicationInput
function assertDateKey(value: unknown, field: string): void   // YYYY-MM-DD, real calendar date
```

Rules enforced (400 on each): `startDate` required for `every_interval` and `monthly`; both dates
must be a real `YYYY-MM-DD`; `endDate` not before `startDate`, for every type; `remindersEnabled`
boolean, and not true for `as_needed`; on update, any schedule field without `frequencyType` is
rejected naming `frequencyType`. `startDate` and `endDate` are removed from the `as_needed`
rejected-field list; every other field on it stays rejected.

The PATCH handler calls `resolveRouteTimeZone` and passes the result to `updateMedication`.

### Task 5 — serializer and honouring the dates

`packages/wellness/src/serialize.ts`: map `reminders_enabled` to `remindersEnabled`.

`packages/wellness/src/schedule.ts`: `computeSchedule` skips a medication entirely for the
requested day when that day is before `schedule_start_date` or after `schedule_end_date`.
Both are compared as `YYYY-MM-DD` calendar keys via the existing `dateKeyFromColumn`.

### Task 6 — tests

`tests/integration/wellness-medication-editing.test.ts` (new), modelled on
`tests/integration/wellness-medication-schedule-v2.test.ts`. Each case, and why it fails against a
broken implementation:

| Case | Fails if |
| --- | --- |
| A start date saves and reloads for each of the six types | the widened constraint was not applied, or the route still rejects the field |
| `remindersEnabled` round-trips; omitted means false | the column, the contract, or the serializer is missing a link |
| `remindersEnabled: true` on `as_needed` returns 400 | the route check is missing (a 500 would mean only the database caught it) |
| `every_interval` edited into `monthly` reloads as monthly with the old type's columns empty | the update does not clear inapplicable columns |
| `monthly` edited into `as_needed` and back | the same, in the direction that also clears dose times |
| A schedule field without `frequencyType` returns 400 | the all-or-nothing rule is missing |
| `frequencyType` with a missing required field returns 400 | create and update do not share validation |
| An update of `name` alone still works | the widening broke the existing path |
| A second user editing the first user's medication gets 404 | row-level security no longer covers the widened update path |
| A malformed `startDate` returns 400, not 500 | the date-format check is missing |

`tests/unit/wellness-schedule-start-window.test.ts` (new):

| Case | Fails if |
| --- | --- |
| A daily medication starting tomorrow produces no slot today | the window check is missing |
| A daily medication that ended yesterday produces no slot today | the same, upper bound |
| A cycle medication with a start date later than its anchor keeps the same on/off days | the start date was fed into the engine anchor and shifted the phase |

## Verification

```bash
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
```
Each expects `EXIT=0`. The full gate runs through the `verify-gate` skill, never bare.

## Kill gate

After task 1 lands: if the widened constraint cannot be applied to the dev database without
touching an already-applied migration file, stop and report a blocker rather than working around
it. Owner of that call: this lane, reported through the task record; it does not need Ben.

## End-to-end proof

Against the running dev instance, through the real server: create a daily medication with a start
date and the reminder toggle on, read it back, edit it into a monthly schedule, read that back, and
confirm a medication starting tomorrow contributes no dose slot to today's schedule. Posted on the
PR as a comment whose first line is `LIVE-PATH PROOF`.
