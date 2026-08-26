# Plan — #1969: plain-language schedule summary and next-doses preview

Spec: `docs/specs/1969.md`. Single phase, pure logic, no UI/route/schema change — no kill gate
beyond "does it match the spec's examples and pass the tests".

## Seams check

- `Medication` row shape and all 22 schedule-relevant columns: `packages/db/src/types.ts:790-818`.
- `MedicationFrequencyType`, 8 values: `packages/db/src/types.ts:779-787`.
- Existing row-to-engine-input mapping (not exported) for the six occurrence-engine families:
  `packages/wellness/src/schedule.ts:84-183`.
- `expandOccurrences(schedule, anchor, range): Occurrence[]`, pure, day-by-day scan bounded by
  `anchor.endDate` and the requested range, already timezone-correct (DST gap/fold handled):
  `packages/wellness/src/occurrence-engine.ts:125-161`.
- `Occurrence.at` is a `Date` (UTC instant); `Occurrence.date`/`.time` are the local civil
  date/clock-time strings that produced it: `packages/wellness/src/occurrence-engine.ts:112-119`.
- Package export surface to extend: `packages/wellness/src/index.ts`.
- Test convention: top-level `tests/unit/*.test.ts`, importing from `@moss/wellness`, with a local
  `med(overrides)` builder — `tests/unit/wellness-schedule-engine-parity.test.ts:1-46`.

Open question: none — every piece this plan needs already exists and is cited above.

## Task 1 — `packages/wellness/src/schedule-summary.ts`

New file. Two exported functions plus one shared private mapper (mirrors `toEngineInput` in
`schedule.ts` but always uses the medication's own time zone, per spec):

```ts
export function describeSchedule(medication: Medication): string;
export function nextDoses(medication: Medication, from: Date, count?: number): Date[];
```

- `count` defaults to 3.
- Both call a private `toSummaryEngineInput(medication): { schedule: MedicationSchedule; anchor: ScheduleAnchor } | null`
  (`null` for `as_needed`), which is `toEngineInput` from `schedule.ts` with one change: every
  branch's `anchor.timeZone` is `medication.time_zone ?? "UTC"` (not hardcoded `"UTC"` for the
  open-anchor families). Re-implemented locally rather than importing `toEngineInput`, since that
  function is private to `schedule.ts` and its UTC-pinning is intentional there (see that file's
  module comment) — duplicating the ~15-line switch is cheaper and clearer than exporting a
  function whose contract would then have two callers wanting different time zones.
- `nextDoses`: `null` mapper -> `[]`. Otherwise call `expandOccurrences(schedule, anchor, { from, to: <from + 2 years> })`,
  take the first `count` results' `.at`. Two years is a generous cap for every family this engine
  supports (worst case is `everyInterval` months with a large interval, or `monthly` on a
  day-of-month that's rare — both still resolve within 24 months); a schedule that produces zero
  occurrences in that window (e.g. `weekdays: []`) returns `[]`, not an error.
- `describeSchedule`: switch on `medication.frequency_type` (not the collapsed engine family,
  since `once_daily`/`times_per_day`/`every_n_hours` need different wording despite sharing the
  `daily` family). Sentence pieces, each a small private helper:
  - `formatTimeList(times: string[], tz: string): string` — `"8:00 AM"` / `"8:00 AM and 8:00 PM"`
    / `"8:00 AM, 2:00 PM, and 8:00 PM"` (Oxford comma, `Intl.DateTimeFormat` with `hour`/`minute`
    in `tz` fed a UTC instant built from the civil time, matching how the engine itself converts).
  - `formatWeekdayList(weekdays: Weekday[]): string` — `"Monday"` / `"Monday and Thursday"` /
    `"Monday, Wednesday, and Friday"`, full weekday names, ISO order (Mon..Sun) deduplicated.
  - `formatDate(dateKey: string, tz: string): string` — `"15 June 2026"` (`Intl.DateTimeFormat`
    with `day`/`month: "long"`/`year`, `tz`).
  - `withEndDate(sentence: string, medication: Medication): string` — appends
    `" until <date>."` before the final period when `medication.schedule_end_date` is set, else
    returns `sentence` unchanged. (`cyclical`/daily families have no end-date column, so this only
    ever fires for `every_interval`/`monthly`, which is where the spec's example lives.)
  - Frequency-specific sentence assembly per the spec's eight examples — no new decision beyond
    what the spec already states in prose form.

## Task 2 — `tests/unit/wellness-schedule-summary.test.ts`

New file, same `med(overrides)` pattern as `wellness-schedule-engine-parity.test.ts`. Cases (each
one fails today because the module doesn't exist, and would fail against a broken implementation
because it pins an exact string or exact Date):

1. `once_daily`, one `schedule_times` entry -> exact sentence `"Once a day, at 8:00 AM."`.
2. `times_per_day`, 3 entries -> `"3 times a day, at 8:00 AM, 2:00 PM, and 8:00 PM."`.
3. `specific_weekdays`, `weekdays: [1, 4]` -> `"Every Monday and Thursday, at 9:00 AM."`.
4. `every_n_hours`, `interval_hours: 6`, `schedule_times: ["08:00"]` -> `"Every 6 hours, starting
   at 8:00 AM."`.
5. `cyclical`, `cycle_days_on: 2`, `cycle_days_off: 3`, `cycle_anchor_date: "2026-06-15"` ->
   `"2 days on, 3 days off, starting 15 June 2026, at 7:00 AM."`.
6. `every_interval`/weeks, `interval_count: 2`, `weekdays: [1]`, `schedule_start_date:
   "2026-03-03"` -> `"Every 2 weeks on Monday, starting 3 March 2026, at 9:00 AM."`.
7. `every_interval`/months -> `"Every 2 months, starting 3 March 2026, at 9:00 AM."`.
8. `monthly`/date, `month_day: 15` -> `"On the 15th of each month, at 8:00 AM."`; `month_day_is_last:
   true` -> `"On the last day of each month, at 8:00 AM."`.
9. `monthly`/weekdayPosition, `first`/Monday -> `"On the first Monday of each month, at 8:00 AM."`.
10. `as_needed` -> `"As needed."`.
11. `every_interval` with `schedule_end_date` set -> sentence ends `"... until 1 September
    2026."`.
12. `nextDoses` for a simple daily medication, `from` = a known Monday -> exactly 3 `Date`s, one
    per day, at the expected UTC instants.
13. `nextDoses` for `as_needed` -> `[]`.
14. `nextDoses` respects `medication.time_zone`: a medication with `time_zone: "America/New_York"`
    and a fixed local clock time produces UTC instants 4 or 5 hours later than the naive-UTC
    reading (covers the "respects the time zone" requirement with an assertion a UTC-only
    implementation would fail).
15. `describeSchedule` respects `medication.time_zone`: the same medication's printed clock time
    matches the zone, not raw UTC.

## Task 3 — export

Add to `packages/wellness/src/index.ts`: `export { describeSchedule, nextDoses } from
"./schedule-summary.js";`.

## Verification

```bash
pnpm --filter @moss/wellness typecheck > /tmp/1969-typecheck.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/unit/wellness-schedule-summary.test.ts > /tmp/1969-test.log 2>&1; echo "EXIT=$?"
```
Both expect `EXIT=0`.

Real-instance check (spec's "Done when" item 3): a throwaway `tsx` script against the dev
database's actual `medications` rows, run once, output pasted into the PR description — not
committed, not a UAT spec (no UI surface exists yet for this piece).

## Kill gate

None beyond the tests above — this is a single-phase, additive, pure-logic task with no
downstream dependents in this PR. If a schedule family's engine mapping turns out ambiguous in a
way the spec didn't anticipate, stop and record it as a spec gap in `docs/specs/1969.md` rather
than guessing; owner is this lane.
