# Open time and breaks in the Today schedule — build plan

Issue: #2742 (part of #2521). Spec basis: gap-check comment
`repos/motioneso/moss/issues/comments/5857778882`, item 1, verified against the approved mockup
`docs/superpowers/specs/assets/2026-09-10-today-briefings/morning-1440-opening.png` (and its 375
counterpart), cropped to the schedule region.

## What the mockup shows (grounding, not paraphrase)

Cropped region of `morning-1440-opening.png` (schedule column, left ~55%):
- Legend row: `Moss-planned task` (filled square), `Calendar commitment` (open square), `Open time`
  (dash) — three entries. Live has two (`today-timeline.tsx:119-132`).
- Between two task blocks 15 minutes apart (10:00-10:15): a plain row, time range on the left,
  text "A break before the next block" on the right. No card background, no left accent border.
- Between two task blocks 60 minutes apart (11:00-12:00): the same row shape with the text
  "Open time".
- No card styling on either row — this is a schedule shape, not a placed block.

The closing line ("The evening is open. No more commitments after 4:30.") is outside the captured
850px crop; its wording comes from the coordinator's brief, sourced from the recovered design
study.

## Current state (verified on this branch)

- `apps/web/src/today/day-plan-view-model.ts` — `buildDayItems()` returns `DayItem[]`, sorted by
  start time, with `startsAt`/`durationMinutes`/`endsAt` (blocks never set `endsAt`; only computed
  ad hoc via `rowEndAt()` in `today-timeline.tsx:136-142`).
- `apps/web/src/today/today-timeline.tsx` — `TimelineRow`, `SnapshotRow`, `TimelineLegend`
  (two entries, lines 119-132). No gap/break row exists anywhere in this file.
- `apps/web/src/today/day-plan.tsx` — `DayPlanSection`. The only place that renders the Today-page
  editorial list with `todayLayout` true is `apps/web/src/today/today-page.tsx:596-611`
  (`todayLayout={todayMode === "day"}`) — this is the sole target surface. `todayLayout` is false
  for the evening layout and unset for dialogs/the morning reader rail (`snapshot` prop), so this
  change cannot touch those by construction as long as the new rows are gated on `today === true`
  (the existing local `const today = props.todayLayout === true;` at `day-plan.tsx:272`).
- `packages/shared/src/app-map-core.ts:57-61` — the Today entry's `description` field is one
  narrative string; it needs an added clause once this ships.

## Determinism boundary

All of this is pure arithmetic over already-loaded schedule data (start/end times already on the
page). No model call, no new turn, no non-deterministic input anywhere in this feature.

## Decisions

### New file: `apps/web/src/today/day-plan-gaps.ts`

Named thresholds (unit-tested):

```ts
/** A gap this long or shorter reads as "a break"; anything longer reads as "open time".
    Matches the mockup: a 15-minute gap is a break, a 60-minute gap is open time. */
export const SCHEDULE_BREAK_MAX_MINUTES = 30;

/** Gaps shorter than this are rounding noise, not a real gap, and produce no row. */
export const SCHEDULE_GAP_MIN_MINUTES = 1;
```

Types:

```ts
export type ScheduleGapKind = "break" | "open";

export interface ScheduleGapRow {
  readonly key: string;
  readonly kind: ScheduleGapKind;
  readonly afterItemKey: string; // DayItem.key this gap follows; render it immediately after
  readonly startsAt: string;
  readonly endsAt: string;
  readonly label: string; // "A break before the next block" | "Open time"
}

export interface ScheduleClosingLine {
  readonly key: string;
  readonly afterItemKey: string;
  readonly text: string; // "The evening is open. No more commitments after 4:30pm."
}

export interface ScheduleGaps {
  readonly rows: readonly ScheduleGapRow[];
  readonly closing: ScheduleClosingLine | null;
}
```

Function signature:

```ts
/** Derives gap/break rows and the closing line strictly from items that carry both a real start
    and a real, computable end (endsAt, or startsAt + a positive durationMinutes). An item with a
    start but no computable end cannot be bridged from — it is excluded from the gap chain instead
    of being assigned an invented duration. */
export function buildScheduleGaps(
  items: readonly DayItem[],
  locale: LocaleSettingsDto
): ScheduleGaps;
```

Behavior (test cases — each states why it would fail against a broken implementation):

1. Empty `items` → `{ rows: [], closing: null }`. (A broken version that unconditionally emits a
   closing line would fail this.)
2. One item with start+duration, nothing after → `rows: []`, `closing` present, text built from
   that item's end time. (Catches an implementation that requires ≥2 items to emit anything.)
3. Two items 15 minutes apart → one `"break"` row, `label: "A break before the next block"`,
   `startsAt`/`endsAt` matching the gap exactly. (Catches an off-by-one in the boundary or wrong
   label text.)
4. Two items 60 minutes apart → one `"open"` row, `label: "Open time"`. (Catches an inverted
   threshold comparison.)
5. Two items exactly `SCHEDULE_BREAK_MAX_MINUTES` apart → `"break"`; one minute more → `"open"`.
   (Pins the boundary to the named constant, not a magic number.)
6. Two items 0 minutes apart (back-to-back) or overlapping (negative gap) → no row between them.
   (Catches a negative-duration row leaking through.)
7. A gap of exactly `SCHEDULE_GAP_MIN_MINUTES - 1` seconds... i.e. sub-minute rounding noise → no
   row. A gap of exactly `SCHEDULE_GAP_MIN_MINUTES` → a row. (Pins the noise floor.)
8. An item with a start but no duration and no `endsAt` (`durationMinutes: null`) sitting between
   two fully-timed items → excluded from the chain; no gap is invented using its start as a
   substitute end, and no gap is invented after it either — the chain simply does not bridge
   across it. (Catches "never invent anything" regressions directly.)
9. Unscheduled items (`startsAt: null`) are ignored entirely, at any position in the input array.
10. `items` not pre-sorted by time → function sorts internally by resolved start before deriving
    gaps (defensive; `buildDayItems` already sorts, but the pure function must not assume it).

### `apps/web/src/today/today-timeline.tsx` changes

- Add a third `TimelineLegend` entry: dash swatch + `"Open time"` text, rendered only when the
  caller passes a new optional prop `showOpenTimeLegend?: boolean` (default false) — keeps the
  legend from claiming an unused entry on a day with no gaps, per "if the schedule is empty, show
  nothing new."
- New exported component:

```ts
export function ScheduleGapRowView(props: {
  readonly row: ScheduleGapRow;
  readonly locale: LocaleSettingsDto;
}): JSX.Element;

export function ScheduleClosingLineView(props: {
  readonly line: ScheduleClosingLine;
  readonly locale: LocaleSettingsDto;
}): JSX.Element;
```

Row shape: same `tl-slot` time-column grid as `TimelineRow`, muted text, no card background, no
left accent border — new class `tl-slot--gap` (plain, no `border-left`, per the mockup crop showing
no accent on these rows). Reuses `timeLabel`/`ampm` for the time column exactly like `TimelineTime`.

### `apps/web/src/today/day-plan.tsx` changes

In the `editorial` branch, when `today === true` and `items.length > 0`:
- Compute `const scheduleGaps = buildScheduleGaps(items, props.locale);` once.
- When mapping `items` to `DayItemRow`, after each row check `scheduleGaps.rows` for a row whose
  `afterItemKey` matches the current item's `key` and render a `ScheduleGapRowView` immediately
  after it; after the loop, if `scheduleGaps.closing !== null`, render `ScheduleClosingLineView`.
- Pass `showOpenTimeLegend={scheduleGaps.rows.length > 0}` to `TimelineLegend`.
- No change to the non-`today` branches (evening layout, dialogs, morning reader `snapshot` rows).

### CSS: `apps/web/src/styles/kit-today-timeline.css`

- `.tl-legend__gap`: an 8px dash (`border-top: 1px solid var(--text-muted)`, no fill/border like
  the filled/open swatches) — matches the mockup's plain dash.
- `.tl-slot--gap`: no `border-left` (override the default slot look), muted text
  (`color: var(--text-muted)`), no `.tl-body` background tint. Reuses `.tl-slot`'s grid layout.
- Run the invented-class audit (design-system skill) after: `grep -rhoE "jds-[a-zA-Z0-9_-]+"` over
  the touched files — this feature adds no new `jds-*` hooks, only `tl-*` ones already governed by
  this file's own comment header, so the audit should show no new names to define elsewhere.

### `packages/shared/src/app-map-core.ts`

Append a clause to the Today `description` (line ~57-61) noting the schedule shows open time and
breaks between blocks, plus a closing line after the last commitment.

## Open question — resolved, not escalated

Whether the closing line's time carries am/pm. The brief's quoted wording ("...after 4:30.") drops
it, but every other time in this schedule shows am/pm (`TimelineTime`, `compactTime`). Decision:
carry am/pm for consistency with the rest of the page ("...after 4:30pm."). This is a copy
micro-decision within the given wording pattern, not a new behavior — proceeding without
escalating; flagged here for the record.

## Kill gate

After this single phase (there is only one phase — this is a session-sized slice), the observation
that would stop before merge: the browser test shows the gap/break rows rendering with wrong
adjacency (e.g. a break row appearing before the wrong block) on real seeded data. Owner: this
lane. If seen, fix within this same slice; do not ship a second phase — there isn't one planned.

## Tests

- Unit: `tests/unit/today-schedule-gaps.test.ts` — the 10 cases above, pure function, no React,
  following the fixture-builder pattern in `tests/unit/today-day-plan-view-model.test.tsx`.
- Browser/component: extend `tests/unit/today-day-plan.test.tsx` (or a new
  `tests/unit/today-day-plan-gap-rows.test.tsx` if the existing file is already large) to render
  `DayPlanSection` with `todayLayout` true and a plan containing a 15-minute and a 60-minute gap,
  asserting: a break row with the exact label, an open-time row with the exact label, the legend
  shows three entries, and the closing line text appears once after the last item. TDD: write these
  first, watch them fail against the current two-entry legend and gap-less list, then implement.
- Live-path: UAT capture at 1440 and 375 on a disposable dev instance (never the shared dev DB, never
  :1533), Today page in morning mode with seeded data producing both a break and an open-time gap.

## Verification commands

```bash
pnpm --filter web exec vitest run tests/unit/today-schedule-gaps.test.ts tests/unit/today-day-plan.test.tsx > /tmp/2742-unit.log 2>&1; echo "EXIT=$?"
# Expected: EXIT=0
```

Full gate per the `verify-gate` skill (eslint + typecheck + these tests) before push — never piped,
never run without that skill's DB recipe.

## Release note

Category: Added. Title: "Open time and breaks in the day's schedule." Description: "The Today
page's schedule now shows the gaps between your task blocks and appointments — a short break, or
open time — and tells you when the day's commitments are done."
