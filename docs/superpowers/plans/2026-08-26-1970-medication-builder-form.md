# Plan — #1970 medication builder form, all six schedule types

Spec: `SPEC` comment on issue #1970 (piece 3 of the #1965 re-slice).
Branch: `fleet/lane-1970`. Risk tier: security (adversarial QA + Ben merge sign-off).
Scope: **adding** a medication only. Editing a saved schedule is #1971 and stays out of this PR.

## Seams check — every capability this plan assumes, cited on this branch

| Assumption                                                                        | Evidence on this branch                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Eight stored frequency values behind six user choices                             | `packages/shared/src/wellness-api.ts:15-24`                                                    |
| Create accepts start date, reminders and every v2 schedule field                  | `packages/shared/src/wellness-api.ts:108-131`                                                  |
| Server validation rules per type (what is required, what is banned)               | `packages/wellness/src/medication-request-parsing.ts:44-170`                                   |
| Start/end date allowed on every type; required for `every_interval` and `monthly` | `packages/wellness/src/medication-request-parsing.ts:128-139`                                  |
| Reminders rejected for as-needed                                                  | `packages/wellness/src/medication-request-parsing.ts:237-238`                                  |
| Scheduled families need at least one clock time                                   | `packages/wellness/src/medication-request-parsing.ts:56-59`                                    |
| `cyclical` needs an anchor date and days-on                                       | `packages/wellness/src/medication-request-parsing.ts:69-73`                                    |
| Plain-language summary and next-doses exist and are pure                          | `packages/wellness/src/schedule-summary.ts:25`, `:44`                                          |
| Those two files import nothing from Node; only a type-only `@moss/db` import      | `packages/wellness/src/schedule-summary.ts:1-10`, `occurrence-engine.ts:1`, `schedule.ts:1-10` |
| The browser must not import the wellness package root (manifest pulls `node:url`) | `packages/shared/src/wellness-api.ts:834-836`                                                  |
| The web app already depends on `@moss/wellness`                                   | `apps/web/package.json` dependencies                                                           |
| The form today offers only three of the eight types                               | `apps/web/src/wellness/manage-meds-modal.tsx:223`                                              |
| Server records the caller's own time zone on create                               | `packages/wellness/src/repository.ts:113-125`, `:189-201`                                      |
| The modal is opened from the "Manage" button on the wellness page                 | `apps/web/src/wellness/wellness-today.tsx:271-279`, `wellness-page.tsx:283`                    |

Open questions: none. Every premise above was read on this branch, not inherited from the spec.

## The design fork, and why

**How does the form show a live summary and the next three doses before anything is saved?**

Chosen: run the existing summary and next-doses functions **in the browser**, by adding one
browser-safe entry point to the wellness package (`./schedule-summary`). The functions are already
pure and Node-free; the preview then updates on every keystroke with no network call, and there is
no new server route, no new authorisation surface, and no new way to reach another user's data.

Rejected, steelmanned: **a server preview endpoint.** Its real advantage is that the preview would
be computed by exactly the code that will later compute the real doses, so the two can never drift
— which is a genuine risk with any client-side copy. That advantage does not apply here, because
the browser would run the _same source file_, not a copy; drift is impossible by construction. The
cost is real: a new authenticated route on a security-tier PR, plus a network round trip per
keystroke on a form whose whole point is that it responds instantly. Rejected.

## Determinism boundary

No model is involved anywhere in this feature. Every label, the summary sentence and the three
preview dose times are computed from the form's own values by the functions cited above, and the
saved record comes back from the server. Nothing on this screen renders model output.

## Task 1 — let the browser use the summary and next-doses functions

`packages/wellness/package.json`: add `"./schedule-summary": "./src/schedule-summary.ts"` to
`exports`, beside the existing `"./settings"` entry.

Nothing else changes in the wellness package.

Test: `tests/unit/wellness-schedule-summary-browser-safe.test.ts` — walks the import graph reachable
from `schedule-summary.ts` and asserts no file in it has a runtime `node:` import or imports the
wellness package index. Against a broken implementation (someone later adds `node:crypto` to
`schedule.ts`, or re-points the export at the index) this fails, where a plain typecheck would not:
the web build would break only at bundle time, in CI, with an opaque error.

## Task 2 — the form's own logic, as plain functions

New file `apps/web/src/wellness/medication-schedule-form.ts`. No React; pure and directly testable.

```ts
export type ScheduleChoice =
  | "daily"
  | "selected_days"
  | "every_interval"
  | "monthly"
  | "cycle"
  | "as_needed";

export const SCHEDULE_CHOICES: readonly { value: ScheduleChoice; label: string; hint: string }[];

export interface MedFormState {
  name: string;
  dose: string;
  choice: ScheduleChoice;
  times: string[]; // clock times, "HH:MM"
  weekdays: number[]; // ISO 1..7
  intervalCount: number;
  intervalUnit: "days" | "weeks" | "months";
  monthKind: "date" | "weekdayPosition";
  monthDay: number;
  monthDayIsLast: boolean;
  monthWeekdayPosition: "first" | "second" | "third" | "fourth" | "last";
  monthWeekday: number;
  cycleDaysOn: number;
  cycleDaysOff: number;
  startDate: string; // "" means not set
  remindersEnabled: boolean;
}

export function emptyMedForm(today: string): MedFormState;
export function withChoice(
  state: MedFormState,
  choice: ScheduleChoice,
  today: string
): MedFormState;
export function startDateRequired(choice: ScheduleChoice): boolean;
export function supportsReminders(choice: ScheduleChoice): boolean;

/** Every reason this form cannot be saved yet, in plain English, or an empty list. */
export function describeFormProblems(state: MedFormState): string[];

export function buildCreateRequest(state: MedFormState): CreateMedicationRequest;

/** The form's values shaped as a saved medication row, so the shipped summary and
 *  next-doses functions can preview it before anything is written. */
export function previewMedication(state: MedFormState, timeZone: string): Medication;
```

Decisions this encodes:

- Six choices map onto the stored values as: daily → `once_daily` with one clock time, or
  `times_per_day` with more than one; selected days → `specific_weekdays`; every so often →
  `every_interval`; monthly → `monthly`; cycle → `cyclical`; only when needed → `as_needed`.
- `withChoice` **replaces** the schedule fields rather than merging them, so a leftover value from
  the previous choice can never reach the server. That mirrors the all-or-nothing rule the server
  enforces at `medication-request-parsing.ts:288-295`.
- Start date is offered on all six choices and is required for "every so often" and "monthly",
  matching the server.
- For a cycle, the one start-date field fills both `startDate` and `cycleAnchorDate`: the cycle
  counts from the day the person starts taking it.
- The reminder toggle is hidden for "only when needed", because there is no scheduled time to
  remind anyone about and the server rejects it. Spec item 3 says reminders are per medication;
  this is the one type where the server has already ruled it out, so the form matches rather than
  sending a request that would 400.
- `previewMedication` uses the browser's own time zone from `Intl`, which is the same zone the
  server records on create.

Test `tests/unit/wellness-med-builder-form.test.ts` — imports the real functions above, not copies.
The existing `tests/unit/wellness-meds-payload.test.ts` re-implements the old form's logic inside
the test file, so it can pass while the form is broken; this replaces that pattern for the new code.

Cases, and how each fails against a broken implementation:

1. Each of the six choices produces a request the server accepts. Asserted by running the built
   request through the server's own validator (`parseCreateMedicationRequest`) and expecting no
   error. A form that omits `weekdays` for a weekly interval, or `cycleAnchorDate` for a cycle,
   fails here instead of as a 400 in front of the user.
2. Switching choice clears the previous choice's fields — set up a monthly schedule, switch to
   daily, and assert the built request carries no `monthKind` or `monthDay`. A merge-instead-of-
   replace bug passes every other test and produces a DB constraint error in production.
3. Daily with one time builds `once_daily`; daily with three builds `times_per_day` with
   `timesPerDay` 3 and exactly three clock times. Off-by-one between the two counts is the exact
   thing the server rejects at `:61-67`.
4. "Every so often" and "monthly" report a missing start date as a problem and cannot be saved;
   the other four can be saved without one.
5. "Only when needed" builds a request with no scheduling fields at all and no `remindersEnabled`.
6. A malformed clock time is reported as a problem.
7. `previewMedication` fed to `describeSchedule` and `nextDoses` returns a non-empty sentence and
   three dose times for each of the five scheduled choices, and no dose times for as-needed.

Expected: `pnpm vitest run tests/unit/wellness-med-builder-form.test.ts > /tmp/t2.log 2>&1; echo "EXIT=$?"` → `EXIT=0`.

## Task 3 — the form itself

`apps/web/src/wellness/manage-meds-modal.tsx`: replace the add-a-medication section with a builder
driven entirely by Task 2. The list of existing medications and the remove button are untouched.

Layout, top to bottom: name and dose; a row of six schedule choices; the fields that choice needs;
a start date; a reminder switch; then a preview panel showing the plain-language sentence and the
next three doses; then the add button, disabled while `describeFormProblems` is non-empty, with the
first problem shown as text next to it.

The preview recomputes from form state on every change — no network, no debounce.

Phone width: the choice row wraps, and every field row is a single column below 480px. The existing
modal is already a scrolling sheet, so no new scroll container.

Test `tests/unit/wellness-manage-meds-modal.test.tsx` — renders the real component with a stubbed
network layer, and asserts through the wiring rather than on props:

1. Picking each of the six choices shows that choice's own fields and hides the others'.
2. The preview sentence and three dose times appear and change when a clock time changes — proves
   the preview is wired to state, not rendered once.
3. Pressing add sends exactly the request Task 2 built, captured at the network boundary — proves
   the form's values reach the server rather than a default. This is the `wired-not-just-defined`
   check: a builder function can pass its own unit test with no caller.
4. The reminder switch is absent for "only when needed" and present for the other five.

## Task 4 — styles

Any new class goes in `apps/web/src/styles/wellness-3.css` beside the existing `.wl-freqbtn` block,
using tokens only — no raw colours in the component, per the design system rules. The audit
(`grep` for used-but-undefined `wl-*` classes) must print nothing **new**; the file already has
pre-existing undefined classes, which this PR does not adopt and does not widen.

Verification: `grep -rhoE "wl-[a-zA-Z0-9_-]+" apps/web/src/wellness | sort -u > /tmp/used.txt` diffed
against the defined set, compared to the same list taken from `origin/main`. Expected: no additions.

## Task 5 — live proof and release note

- `tests/uat/specs/1970-medication-builder.uat.spec.ts` — signs in on a real instance, opens the
  wellness page, opens Manage, and creates one medication of **each** of the six types through the
  real form, then reads them back from the real list endpoint and asserts each saved row carries the
  schedule that was picked. This is the spec's "every schedule type can be created through the
  form" exit criterion, exercised end to end with no mocked data.
- A row in `.claude/skills/coordinate/uat-trigger-map.tsv`, mode `blocking`, for
  `apps/web/src/wellness/**`.
- Release note: Category `Added`, and `node scripts/append-release-note.mjs --pr <number>` run on
  this branch after the PR exists, with the resulting `docs/WHATS_NEW.md` change committed here.

## Kill gate after Task 2

If the browser cannot use the summary and next-doses functions — the web build breaks, or the
preview needs data only the server has — then the live preview is a bigger piece of work than this
slice holds. Owner: this lane. The call is recorded with `fleetctl` and the lane asks for a
re-slice rather than inventing a server route inside a security-tier PR.

## Verification (never piped)

```bash
pnpm vitest run tests/unit/wellness-med-builder-form.test.ts tests/unit/wellness-manage-meds-modal.test.tsx tests/unit/wellness-schedule-summary-browser-safe.test.ts > /tmp/1970-unit.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm format:check > /tmp/1970-fmt.log 2>&1; echo "EXIT=$?"                                          # expect EXIT=0
pnpm lint > /tmp/1970-lint.log 2>&1; echo "EXIT=$?"                                                 # expect EXIT=0
pnpm typecheck > /tmp/1970-tc.log 2>&1; echo "EXIT=$?"                                              # expect EXIT=0
```

The full gate runs under the `verify-gate` skill at wrap-up; it is never run bare, because an
unscoped run reaches the live dev database.
