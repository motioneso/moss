# Plan: switch medication schedule computation to the shared occurrence engine (#1953)

No live coordinator in this fleet-daemon run; logging plan via fleetctl instead of pane message.

## Finding from branch verification

All four surfaces named in the spec (schedule preview route, insights/adherence route, data
export job, and the adherence-summary route) call one shared function,
`computeSchedule` in `packages/wellness/src/schedule.ts`. So the actual switch is a single-file
change: rewrite `computeSchedule`'s internals to call `expandOccurrences` from
`packages/wellness/src/occurrence-engine.ts` instead of doing its own date math. That
transitively switches all four call sites in one commit, and matches "delete the private date
math so it cannot drift back."

One real gap found: `every_n_hours` medications have no matching family in the engine (it only
has daily / selectedDays / everyInterval / monthly / cycle / asNeeded). Fix without extending the
engine (out of scope per #1950's spec): the set of clock times an every-N-hours medication fires
at in one civil day is fixed (does not depend on which day), so precompute that list of `HH:MM`
times once and hand it to the engine as a `daily` schedule with those `doseTimes`. Verified this
produces the same instants as the old `intervalSlots` loop.

Mapping `frequency_type` -> engine schedule (`timeZone: "UTC"` always, matching the current
"naive civil time treated as UTC" model documented in schedule.ts):

- `once_daily`, `times_per_day` -> `daily`, doseTimes = `schedule_times`.
- `specific_weekdays` -> `selectedDays`, weekdays = `weekdays`, doseTimes = `schedule_times`.
- `every_n_hours` -> `daily`, doseTimes = precomputed times from `interval_hours` + first
  `schedule_times` entry (or 00:00).
- `cyclical` with both `cycle_anchor_date` and `cycle_days_on` set and cycle length > 0 ->
  `cycle` family, anchor.startDate = `cycle_anchor_date`. Otherwise (either missing, or
  `cycle_days_on <= 0`) -> `daily` (matches the old `isCyclicalOnDay`'s "always eligible"
  fallback for a misconfigured cycle).
- `as_needed` -> handled separately, unchanged (no occurrence, single PRN-count slot).
- Anchor `startDate` for every non-cycle family: a fixed date far in the past (the engine
  requires one, but the old code never gated on a start date for these families) — using
  `1970-01-01` so it never filters out a real query day, preserving old behavior exactly.

## Safety net (write first, before touching schedule.ts)

New pure unit test file: `tests/unit/wellness-schedule-engine-parity.test.ts`. Covers one
representative case per frequency type plus edge cases (cyclical before its anchor date,
misconfigured cyclical, every_n_hours with multiple times, weekend-only weekdays). Each case
hand-computed against the CURRENT (pre-refactor) `computeSchedule` so it is a real golden-output
comparison, not a tautology. Confirmed passing against the current code before refactoring, then
must stay green after.

Also: a same-day-logging test confirming logging a dose does not change any other day's slots
(no shared mutable state) — cheap, already implied by pure-function contract, but stated as an
explicit case per the spec's "logging a late or skipped dose does not change future doses"
exit criterion.

## Steps

1. Write `tests/unit/wellness-schedule-engine-parity.test.ts` against current code. Run, confirm
   green (this is the "before" snapshot).
2. Rewrite `packages/wellness/src/schedule.ts`: add the mapping function, replace the day-loop
   eligibility/time logic with one call to `expandOccurrences`, delete `isCyclicalOnDay`,
   `intervalSlots`, `isoWeekdayOf`, `combineDateAndTime` (now dead).
3. Re-run the parity test file plus the existing `computeSchedule (pure)` block in
   `tests/integration/wellness.test.ts` (pure describe block, but the file connects to a DB in
   other blocks — run through the gate, not directly). Fix until green.
4. Typecheck + lint + format on touched files.
5. Full gate via the verify-gate skill (not run directly).
6. `coordinated-wrap-up`: push, PR, live-path proof (Today dose list looks identical before/after
   on the dev instance), release note (Category: N/A — no user-visible change).

## Exit criteria mapping

- "Four surfaces use the shared engine, old private math removed" -> step 2.
- "Comparison test confirms schedules unchanged" -> step 1 test file.
- "Logging a dose doesn't change future doses" -> explicit case in step 1, also true by
  construction (pure function, no shared state).
- "Live check on dev shows Today list matches" -> step 6.
