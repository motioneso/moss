// external-modules/food/src/web/root.tsx
//
// Food phase 2 (#1737, spec 2026-08-19 §Web): the day view, rebuilt on the
// host's keyline primitives (apps/web/src/styles/components-keyline.css) —
// hairline rules and committed fields, no floating cards. Phase 1's version
// wrapped every element in a card, which Ben ruled reads as a generic
// AI-design tell (2026-08-19).
//
// Three things this screen owes the user, in order: the day's calories against
// nothing else on the line, the macros as ruled instrument fields, and the
// meals grouped the way a day is actually thought about rather than as a flat
// list. A meal expands into the foods it contained (#1737).
//
// Determinism boundary (plan §3): every rendered value is read straight off
// the tool result record. Nothing here calls the model or interprets model
// output; a null nutrient renders as an em dash, never 0 — the estimator's
// "never coalesce a missing nutrient" rule (domain/totals.ts) has to survive
// all the way to the pixel or the page quietly under-reports the day.
//
// Only risk:read tools are invoked (food.meals.list). No
// write or destructive tool is reachable from here; worker-rpc-host.ts throws
// on one from a read-risk surface.
import { invokeTool, type ToolOutcome } from "./api";
import type { CaptureKind, DailyTotals, EstimateState, Meal, MealItem } from "../domain/meal.js";
import { netCarbsG } from "../domain/totals.js";
import { NO_TARGETS, type DailyTargets } from "../domain/targets.js";
import {
  OCCASION_LABEL,
  OCCASION_ORDER,
  occasionForMeal,
  type Occasion
} from "../domain/occasion.js";
import { todayLocalDayKey } from "@moss/module-sdk/time";

import { Fragment, h, useCallback, useEffect, useState, type ReactNodeLike } from "./runtime";

// ── local "today" (no ambient ISO-slice) ────────────────────────────────

/** Browser-local calendar date as YYYY-MM-DD, for the picker's initial value. Uses the device's
 * own timezone (there is no persisted user timezone read from here) — this is a UI default only,
 * not the resolution the store uses to pin a meal to a day (domain/meal.ts's resolveMealLocalDate
 * owns that at write time).
 *
 * #1723 item 1: was four lines of hand-assembled getFullYear/getMonth/getDate. Same answer, but
 * routed through the shared helper so there is one place where a day key is built and one place to
 * fix if it is ever wrong. The device zone is read explicitly rather than left implicit, which is
 * what makes it visible that this default is the *device's* day and not the user's configured one. */
function todayLocalDate(): string {
  return todayLocalDayKey(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

// ── query, with the two refreshes the day view actually needs ────────────

/** How often a day still holding an unfinished estimate re-reads itself. */
const PENDING_POLL_MS = 5_000;

type QueryState<T> = { status: "loading" } | { status: "settled"; outcome: ToolOutcome<T> };

/**
 * A per-mount query with two refresh triggers (#1737, spec §Web "known
 * adjacent defect"):
 *
 * 1. **Tab becomes visible again.** Phase 1 fetched once per mount and never
 *    again, so a meal logged in Chat did not appear on this page until a
 *    manual reload — a day view that silently omits a just-logged meal is
 *    wrong regardless of how well it computes totals.
 * 2. **An interval, but only while `refreshMs` is non-null.** The caller
 *    passes a number only while the day holds a meal whose estimate has not
 *    landed, so a settled day makes no repeat requests at all.
 *
 * Neither trigger shows a loading state: a refresh swaps the settled result
 * underneath, so the numbers on screen never flash back to "Loading…".
 */
function useToolQuery<T extends Record<string, unknown>>(
  name: string,
  input: Record<string, unknown>,
  refreshMs: number | null = null
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const load = (): void => {
      void invokeTool<T>(name, input).then((outcome) => {
        if (!cancelled) setState({ status: "settled", outcome });
      });
    };
    load();

    const onVisibilityChange = (): void => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // inputKey stands in for `input` (a fresh object identity every render);
    // `name` is effectively constant per call site. Deliberately excludes
    // refreshMs — the interval below owns that, and re-running this effect on
    // it would drop the page back to "Loading…" every time an estimate landed.
  }, [name, inputKey]);

  useEffect(() => {
    if (refreshMs === null) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (document.hidden) return; // no traffic from a tab nobody is looking at
      void invokeTool<T>(name, input).then((outcome) => {
        if (!cancelled) setState({ status: "settled", outcome });
      });
    }, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name, inputKey, refreshMs]);

  return state;
}

// ── formatting ──────────────────────────────────────────────────────────

/** Meal time in the meal's OWN persisted offset (never the viewer's browser zone — a meal is
 * pinned at create time per domain/meal.ts's resolveMealLocalDate, and re-deriving its clock time
 * from the viewer's ambient zone could show a different hour than what was actually logged). */
function formatMealTime(consumedAt: string, timezoneOffsetMinutes: number): string {
  const instant = new Date(consumedAt);
  if (Number.isNaN(instant.getTime())) return "—";
  const shifted = new Date(instant.getTime() + timezoneOffsetMinutes * 60_000);
  const hours = shifted.getUTCHours();
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelveHour}:${minutes} ${period}`;
}

/** Grouped thousands, written out rather than taken from toLocaleString: the locale form varies
 * by the machine running it, which would make the rendered output untestable. */
function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `null` renders as an em dash — never 0. A "0 g protein" the user never had estimated is the
 * exact bug the domain's never-coalesce rule guards against (domain/totals.ts).
 */
function formatFigure(value: number | null, decimals = 0): string {
  if (value === null) return "—";
  const fixed = value.toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const grouped = groupThousands(whole ?? "0");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function formatWithUnit(value: number | null, unit: string, decimals = 0): string {
  return value === null ? "—" : `${formatFigure(value, decimals)} ${unit}`;
}

/**
 * The one line under a figure that states its target. Returns null when there is no target, which
 * is what keeps an unset target from drawing an empty progress affordance.
 *
 * A null total with a target set is a real state — a day with a target and nothing estimated yet —
 * and it says only what the target is. Computing "0 left" there would claim the user has eaten
 * nothing when the truth is that nothing has been estimated, which is a different statement.
 */
function targetNote(total: number | null, target: number | null, unit: string): string | null {
  if (target === null) return null;
  const goal = `of ${formatFigure(target)} ${unit}`;
  if (total === null) return goal;
  const remaining = target - total;
  // Past the target, say "over" with a positive figure. A negative amount left is arithmetic,
  // not a sentence anybody says about their day.
  if (remaining >= 0) return `${goal} · ${formatWithUnit(remaining, unit)} left`;
  return `${goal} · ${formatWithUnit(-remaining, unit)} over`;
}

const CAPTURE_KIND_LABEL: Record<CaptureKind, string> = {
  text: "Typed",
  photo: "Photo",
  voice: "Voice"
};

const ESTIMATE_STATE_LABEL: Record<EstimateState, string> = {
  pending: "Estimating…",
  needs_details: "Needs details",
  estimated: "Estimated",
  failed: "Estimate failed"
};

/**
 * #1770: a meal logged while estimates are off is `pending` by construction — createMeal inserts
 * that state and, with the switch off, tools/meals.ts:289-292 returns without ever moving it on.
 * "Estimating…" would then be a permanent lie about background work that was never started, so
 * the one state gets two labels depending on whether anything is actually coming.
 */
function estimateStateLabel(state: EstimateState, aiEstimates: boolean): string {
  return state === "pending" && !aiEstimates ? "Not estimated" : ESTIMATE_STATE_LABEL[state];
}

/**
 * The row's leading 3px rail carries the estimate state — never a border on the row and never a
 * coloured pill, per the keyline idiom. The occasion accent lives on the section head above
 * instead, so the two signals never fight over the same 3 pixels.
 */
const ESTIMATE_STATE_RAIL: Record<EstimateState, string> = {
  pending: "jds-rail--line",
  needs_details: "jds-rail--gold",
  estimated: "jds-rail--accent",
  failed: "jds-rail--danger"
};

const OCCASION_RAIL: Record<Occasion, string> = {
  breakfast: "jds-rail--morning",
  lunch: "jds-rail--afternoon",
  dinner: "jds-rail--evening",
  snack: "jds-rail--gold"
};

// ── the day's headline figures ──────────────────────────────────────────

/**
 * Calories alone at display scale, then the macros as ruled instrument fields.
 *
 * Targets (#1737 item 4) are declared as integer module preferences and drawn by the host
 * settings page (#1725/#1757); Food never builds a settings pane. Every target is optional and
 * unset is a supported end state, so a nutrient with no target shows a plain figure and no
 * progress at all — story 45. An empty bar, a 0%, or a NaN is worse than a plain number, and is
 * the usual shape of this bug. A target with nothing logged against it is the same case: the
 * total is null, so there is nothing to be a fraction of and only the target itself is stated.
 */
function DayHeadline(props: { totals: DailyTotals; targets: DailyTargets }): ReactNodeLike {
  const { nutrients, incomplete, mealsWithoutEstimate } = props.totals;
  const { targets } = props;
  const fields: ReadonlyArray<{ label: string; value: string; note: string | null }> = [
    {
      label: "Protein",
      value: formatWithUnit(nutrients.proteinG, "g", 1),
      note: targetNote(nutrients.proteinG, targets.proteinG, "g")
    },
    // Net carbs is computed here and stored nowhere; null unless both carbohydrates and fiber
    // carry a number, so an unestimated fiber figure never inflates the answer.
    {
      label: "Net carbs",
      value: formatWithUnit(netCarbsG(nutrients), "g", 1),
      note: targetNote(netCarbsG(nutrients), targets.netCarbsG, "g")
    },
    {
      label: "Fat",
      value: formatWithUnit(nutrients.fatG, "g", 1),
      note: targetNote(nutrients.fatG, targets.fatG, "g")
    },
    { label: "Fiber", value: formatWithUnit(nutrients.fiberG, "g", 1), note: null },
    { label: "Sugar", value: formatWithUnit(nutrients.sugarG, "g", 1), note: null },
    { label: "Sodium", value: formatWithUnit(nutrients.sodiumMg, "mg", 0), note: null }
  ];
  const calorieNote = targetNote(nutrients.caloriesKcal, targets.caloriesKcal, "kcal");
  return (
    <section className="fud-day">
      <p className="jds-instrument__label fud-day-label">Calories</p>
      <p className="jds-display jds-display--xl">{formatFigure(nutrients.caloriesKcal)}</p>
      {calorieNote ? <p className="jds-caption fud-day-target">{calorieNote}</p> : null}
      <div className="fud-day-fields">
        {fields.map((field) => (
          <div className="jds-instrument fud-day-field" key={field.label}>
            <p className="jds-instrument__label">{field.label}</p>
            <p className="jds-instrument__value">{field.value}</p>
            {field.note ? <p className="jds-caption fud-day-target">{field.note}</p> : null}
          </div>
        ))}
      </div>
      {incomplete ? (
        <p className="jds-caption fud-disclosure" role="note">
          {mealsWithoutEstimate === 1
            ? "1 meal today has no finished estimate, so it is not counted above."
            : `${mealsWithoutEstimate} meals today have no finished estimate, so they are not counted above.`}
        </p>
      ) : null}
    </section>
  );
}

// ── one food inside a meal ──────────────────────────────────────────────

function ItemRow(props: { item: MealItem; key?: string }): ReactNodeLike {
  const { label, portionNote, nutrients } = props.item;
  return (
    <li className="fud-item">
      <span className="fud-item-label">
        {label}
        {portionNote ? <span className="jds-caption fud-item-portion">{portionNote}</span> : null}
      </span>
      <span className="fud-item-figures jds-caption">
        <span className="fud-item-kcal">{formatWithUnit(nutrients.caloriesKcal, "kcal")}</span>
        <span className="jds-meta-sep" aria-hidden="true" />
        <span>P {formatFigure(nutrients.proteinG, 1)}</span>
        <span className="jds-meta-sep" aria-hidden="true" />
        <span>C {formatFigure(nutrients.carbohydratesG, 1)}</span>
        <span className="jds-meta-sep" aria-hidden="true" />
        <span>F {formatFigure(nutrients.fatG, 1)}</span>
      </span>
    </li>
  );
}

// ── one meal ────────────────────────────────────────────────────────────

function MealRow(props: {
  meal: Meal;
  expanded: boolean;
  aiEstimates: boolean;
  onToggle: (mealId: string) => void;
  key?: string;
}): ReactNodeLike {
  const { meal, expanded, aiEstimates, onToggle } = props;
  const hasItems = meal.items.length > 0;
  const panelId = `fud-items-${meal.mealId}`;

  // The meta line: the time always, then only what is worth saying. "Typed" on every row is
  // noise, and so is "Estimated" on a row already showing its numbers — a meta line that always
  // says the same thing stops being read.
  const meta: ReactNodeLike[] = [
    <span key="time">{formatMealTime(meal.consumedAt, meal.timezoneOffset)}</span>
  ];
  if (meal.captureKind !== "text") {
    meta.push(<span className="jds-meta-sep" aria-hidden="true" key="sep-capture" />);
    meta.push(<span key="capture">{CAPTURE_KIND_LABEL[meal.captureKind]}</span>);
  }
  if (meal.estimateState !== "estimated") {
    meta.push(<span className="jds-meta-sep" aria-hidden="true" key="sep-state" />);
    meta.push(<span key="state">{estimateStateLabel(meal.estimateState, aiEstimates)}</span>);
  }
  if (hasItems) {
    meta.push(<span className="jds-meta-sep" aria-hidden="true" key="sep-items" />);
    meta.push(
      <span key="items">{meal.items.length === 1 ? "1 food" : `${meal.items.length} foods`}</span>
    );
  }

  // Direct h() call rather than <>…</>: Fragment is typed unknown (host-provided), which JSX
  // fragment syntax rejects — the same workaround finance/src/web/states.tsx:86 uses.
  const body = h(
    Fragment,
    null,
    <span className={`jds-rail ${ESTIMATE_STATE_RAIL[meal.estimateState]}`} aria-hidden="true" />,
    <span className="fud-meal-body">
      <span className="fud-meal-head">
        <span className="fud-meal-desc">
          {meal.description}
          {meal.servingNote ? ` (${meal.servingNote})` : ""}
        </span>
        <span className="fud-meal-kcal jds-instrument__value">
          {formatWithUnit(
            meal.estimateState === "estimated" ? (meal.nutrients?.caloriesKcal ?? null) : null,
            "kcal"
          )}
        </span>
      </span>
      <span className="fud-meal-meta jds-caption">{meta}</span>
    </span>
  );

  const onClick = useCallback(() => onToggle(meal.mealId), [onToggle, meal.mealId]);

  return (
    <li className="fud-meal">
      {hasItems ? (
        // A row is only a button when pressing it does something. A meal with no breakdown —
        // logged before this shipped, or still being estimated — stays inert rather than
        // offering an expander that opens onto nothing.
        <button
          type="button"
          className="jds-hairline-row jds-rail-row fud-meal-row"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onClick}
        >
          {body}
        </button>
      ) : (
        <div className="jds-hairline-row jds-rail-row fud-meal-row fud-meal-row--inert">{body}</div>
      )}
      {hasItems && expanded ? (
        <ul className="fud-items" id={panelId}>
          {meal.items.map((item, index) => (
            <ItemRow item={item} key={`${meal.mealId}:${index}`} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ── occasion grouping ───────────────────────────────────────────────────

interface OccasionGroup {
  readonly occasion: Occasion;
  readonly meals: readonly Meal[];
}

/** Meals bucketed by occasion, in day order, dropping any occasion nothing landed in — an empty
 * "Dinner" header above nothing reads as a missing meal rather than as a day that is not over. */
export function groupByOccasion(meals: readonly Meal[]): readonly OccasionGroup[] {
  const buckets = new Map<Occasion, Meal[]>();
  for (const meal of meals) {
    const occasion = occasionForMeal(meal.consumedAt, meal.timezoneOffset);
    const existing = buckets.get(occasion);
    if (existing) existing.push(meal);
    else buckets.set(occasion, [meal]);
  }
  const groups: OccasionGroup[] = [];
  for (const occasion of OCCASION_ORDER) {
    const bucket = buckets.get(occasion);
    if (bucket && bucket.length > 0) groups.push({ occasion, meals: bucket });
  }
  return groups;
}

// ── root ────────────────────────────────────────────────────────────────

interface MealsListResult extends Record<string, unknown> {
  meals: Meal[];
  totals: DailyTotals | null;
  aiEstimates?: boolean;
  targets?: DailyTargets;
}

/**
 * The one action the host hands an external web surface (#916,
 * apps/web/src/external-modules/host-actions.ts). It opens the assistant drawer with an EDITABLE
 * draft and never submits — so this stays a read-risk surface: nothing here writes, the user
 * still sends the turn themselves, and the existing food.meals.log tool does the writing exactly
 * as it does for a typed message. Shape mirrors finance's own declaration rather than importing
 * one: a module may depend only on @moss/module-sdk, @moss/module-web-sdk and @moss/host-fetch,
 * never on another module's internals.
 */
export type HostActions = { openAssistant: (input: { starterPrompt: string }) => void };

/**
 * #1787: the page's only way to START logging. Ben, at the #926 kill gate: the page read as
 * missing a feature, "there should be a log button on the food page even if it just opens up the
 * drawer".
 *
 * The draft names the day being viewed whenever that is not today. Without it, a user looking at
 * Tuesday who clicks Log would have their meal written to Wednesday — the tool resolves the day at
 * write time from the message, and the page's date picker is invisible to it. Naming the date is
 * also honest about what will happen, since the user reads the draft before sending it.
 */
function LogMealButton(props: {
  hostActions: HostActions;
  localDate: string;
  className: string;
}): ReactNodeLike {
  const { hostActions, localDate, className } = props;
  const onClick = useCallback(() => {
    // Trailing colon, not a trailing space: the host trims before inserting, so a space would be
    // dropped anyway. Kept short deliberately — it is a sentence opener the user finishes, not a
    // prompt that tries to do the describing for them.
    const starterPrompt =
      localDate === todayLocalDate() ? "Log a meal:" : `Log a meal on ${localDate}:`;
    hostActions.openAssistant({ starterPrompt });
  }, [hostActions, localDate]);
  return (
    <button type="button" className={className} onClick={onClick}>
      Log a meal
    </button>
  );
}

export function Root(props: { hostActions: HostActions }): ReactNodeLike {
  const [localDate, setLocalDate] = useState<string>(todayLocalDate());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Set only while something on this day is still being estimated, so a
  // finished day is entirely silent on the network.
  const [pendingPollMs, setPendingPollMs] = useState<number | null>(null);
  const mealsQuery = useToolQuery<MealsListResult>("food.meals.list", { localDate }, pendingPollMs);

  // #1770: with estimates off nothing is queued, so a meal stays "pending" permanently. Polling
  // on that would ask the server forever for a result that is never coming — the `aiEstimates`
  // guard is what makes "still being estimated" mean it, rather than just "has no numbers yet".
  const hasPending =
    mealsQuery.status === "settled" &&
    mealsQuery.outcome.kind === "ok" &&
    mealsQuery.outcome.result.aiEstimates !== false &&
    mealsQuery.outcome.result.meals.some((meal) => meal.estimateState === "pending");
  useEffect(() => {
    setPendingPollMs(hasPending ? PENDING_POLL_MS : null);
  }, [hasPending]);

  const onDateChange = useCallback((event: { target: { value: string } }) => {
    if (event.target.value) {
      setLocalDate(event.target.value);
      setExpanded({});
    }
  }, []);

  const onToggle = useCallback((mealId: string) => {
    setExpanded((current) => ({ ...current, [mealId]: !current[mealId] }));
  }, []);

  return (
    <div className="fud-root">
      <header className="fud-header">
        {/* Grouped so the three controls travel together at the right edge; without the wrapper
            the header's flex layout spreads four children across the full width and the date
            picker drifts into the middle of nothing. */}
        <div className="fud-header-actions">
          <input
            aria-label="Date"
            className="jds-input jds-input--sm fud-date"
            type="date"
            value={localDate}
            onChange={onDateChange}
          />
          <LogMealButton
            hostActions={props.hostActions}
            localDate={localDate}
            className="jds-btn jds-btn--primary jds-btn--sm fud-log-btn"
          />
          {/*
           * A plain anchor, not a router push: the module runtime hands a web surface React and
           * nothing else (runtime.ts, contract v2), so there is no host navigate to call. The cost
           * is a full page load on click, which is acceptable for a link out of the module and is
           * the only option that needs no platform change.
           */}
          <a
            className="jds-btn jds-btn--quiet jds-btn--sm fud-settings-link"
            href="/settings?section=modules&module=food"
          >
            Settings
          </a>
        </div>
      </header>
      <EstimatesOffNote query={mealsQuery} />
      <MealsSection
        query={mealsQuery}
        expanded={expanded}
        onToggle={onToggle}
        hostActions={props.hostActions}
        localDate={localDate}
      />
    </div>
  );
}

/**
 * #1750 — the note appears only when AI estimation is switched OFF, where it explains why the
 * numbers are missing. Switched on there is nothing to say, so nothing is said: a permanent
 * green "estimates: on" badge is a nag, not information.
 *
 * The flag rides on the meals read result rather than a preference lookup, because a module web
 * surface has no path to a host preference. Rendering it from the record keeps the determinism
 * boundary intact — this note is never model output.
 */
function EstimatesOffNote(props: { query: QueryState<MealsListResult> }): ReactNodeLike {
  const query = props.query;
  if (query.status !== "settled") return null;
  const outcome = query.outcome;
  // Strict `=== false`, matching the gates in tools/meals.ts: an older module build whose
  // list result predates this field must not make the page claim estimates are off.
  if (outcome.kind !== "ok" || outcome.result.aiEstimates !== false) return null;
  return (
    <p className="jds-caption fud-notice" role="status">
      Nutrition estimates are off, so meals are logged without numbers. Turn them back on in
      Settings, under Food.
    </p>
  );
}

function MealsSection(props: {
  query: QueryState<MealsListResult>;
  expanded: Record<string, boolean>;
  onToggle: (mealId: string) => void;
  hostActions: HostActions;
  localDate: string;
}): ReactNodeLike {
  const { query, expanded, onToggle } = props;
  if (query.status === "loading") {
    return (
      <div className="fud-state" role="status">
        <p className="jds-empty__sub">Loading…</p>
      </div>
    );
  }
  const outcome = query.outcome;
  if (outcome.kind === "disabled") {
    return (
      <div className="fud-state" role="status">
        <h2 className="jds-empty__title">Food is turned off</h2>
        <p className="jds-empty__sub">
          This was disabled on the server. Your data is preserved; an administrator can re-enable it
          under Settings.
        </p>
      </div>
    );
  }
  if (outcome.kind === "blocked") {
    return (
      <div className="fud-state" role="status">
        <p className="jds-empty__sub">This data needs confirmation in the assistant.</p>
      </div>
    );
  }
  if (outcome.kind === "error") {
    return (
      <div className="fud-state" role="alert">
        <p className="jds-empty__sub">{outcome.message}</p>
      </div>
    );
  }

  const result = outcome.result;
  if (result.meals.length === 0) {
    return (
      // #1787: this state used to say "Log a meal by talking to the assistant" and then offer no
      // way to do it, which is precisely what made the page read as missing a feature. The button
      // opens the drawer with a draft; the sentence now describes what the button does.
      <div className="fud-state" role="status">
        <h2 className="jds-empty__title">Nothing logged for this day</h2>
        <p className="jds-empty__sub">
          Describe what you ate and your assistant estimates the nutrition.
        </p>
        <LogMealButton
          hostActions={props.hostActions}
          localDate={props.localDate}
          className="jds-btn jds-btn--primary jds-btn--sm"
        />
      </div>
    );
  }

  // Direct h(Fragment, …) for the same reason as MealRow's body above.
  return h(
    Fragment,
    null,
    result.totals ? (
      <DayHeadline totals={result.totals} targets={result.targets ?? NO_TARGETS} />
    ) : null,
    groupByOccasion(result.meals).map((group) => (
      <section className="fud-occasion" key={group.occasion}>
        <div className="jds-section-head">
          <span
            className={`jds-rail ${OCCASION_RAIL[group.occasion]} fud-occasion-rail`}
            aria-hidden="true"
          />
          <span className="jds-eyebrow">{OCCASION_LABEL[group.occasion]}</span>
          <span className="jds-section-head__rule" />
        </div>
        <ul className="fud-meals">
          {group.meals.map((meal) => (
            <MealRow
              meal={meal}
              expanded={expanded[meal.mealId] === true}
              // Strict !== false, matching EstimatesOffNote: an older module build that predates
              // the flag omits it, and must not be read as "estimates are off".
              aiEstimates={result.aiEstimates !== false}
              onToggle={onToggle}
              key={meal.mealId}
            />
          ))}
        </ul>
      </section>
    ))
  );
}
