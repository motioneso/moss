// external-modules/food/src/web/root.tsx
// Food Phase 1 (#926, #1701, plan §5 Task 6): the module's one screen — a
// read-only day view. Native <input type="date"> picks a `localDate`; the
// page invokes exactly three read-risk tools (food.meals.list,
// food.consent.get — food.meals.summarize is Task 6-adjacent and not wired
// here since the day view needs only the single-date shape's `totals`,
// plan §5 Task 6 lists no range/summary UI for this page). No write or
// destructive tool is ever invoked from here (food.meals.log / .correct /
// .delete / .reestimate / consent.grant all throw on a read-risk surface
// per worker-rpc-host.ts) — consent renders read-only with no grant control.
//
// Determinism boundary (plan §3): every rendered value is read straight off
// the tool result record. Nothing here calls the model or interprets model
// output; the estimator's own output already passed through
// domain/totals.ts's "never coalesce a missing nutrient to 0" rule before it
// reached the wire, and this file preserves that by rendering a null
// nutrient as "—", never 0.
import { invokeTool, type ToolOutcome } from "./api";
import type { CaptureKind, DailyTotals, EstimateState, Meal, Nutrients } from "../domain/meal.js";
import { h, useCallback, useEffect, useState, type ReactNodeLike } from "./runtime";

// ── local "today" (no ambient ISO-slice) ────────────────────────────────

/** Browser-local calendar date as YYYY-MM-DD, for the picker's initial value. Uses the device's
 * own timezone (there is no persisted user timezone read from here) — this is a UI default only,
 * not the resolution the store uses to pin a meal to a day (domain/meal.ts's resolveMealLocalDate
 * owns that at write time). */
function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ── tiny per-mount query (no shared cache needed — one page, one query) ──

type QueryState<T> = { status: "loading" } | { status: "settled"; outcome: ToolOutcome<T> };

function useToolQuery<T extends Record<string, unknown>>(
  name: string,
  input: Record<string, unknown>
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const inputKey = JSON.stringify(input);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void invokeTool<T>(name, input).then((outcome) => {
      if (!cancelled) setState({ status: "settled", outcome });
    });
    return () => {
      cancelled = true;
    };
    // inputKey stands in for `input` (a fresh object identity every render);
    // `name` is effectively constant per call site.
  }, [name, inputKey]);
  return state;
}

// ── formatting helpers ────────────────────────────────────────────────────

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

type NutrientKey = keyof Nutrients;

const NUTRIENT_FIELDS: ReadonlyArray<{
  key: NutrientKey;
  label: string;
  unit: string;
  decimals: number;
}> = [
  { key: "caloriesKcal", label: "Calories", unit: "kcal", decimals: 0 },
  { key: "proteinG", label: "Protein", unit: "g", decimals: 1 },
  { key: "carbohydratesG", label: "Carbs", unit: "g", decimals: 1 },
  { key: "fatG", label: "Fat", unit: "g", decimals: 1 },
  { key: "fiberG", label: "Fiber", unit: "g", decimals: 1 },
  { key: "sugarG", label: "Sugar", unit: "g", decimals: 1 },
  { key: "sodiumMg", label: "Sodium", unit: "mg", decimals: 0 }
];

/** `null` renders as an em dash — never 0. A real "0g protein" the user never had estimated is
 * the exact bug the domain's "never coalesce" rule guards against (domain/totals.ts). */
function formatNutrientValue(value: number | null, unit: string, decimals: number): string {
  if (value === null) return "—";
  return `${value.toFixed(decimals)} ${unit}`;
}

// ── nutrient list (shared by a meal row and the totals block) ────────────

function NutrientList(props: { nutrients: Nutrients | null }): ReactNodeLike {
  const nutrients = props.nutrients;
  return (
    <dl className="fud-nutrients">
      {NUTRIENT_FIELDS.map((field) => (
        <div className="fud-nutrient" key={field.key}>
          <dt>{field.label}</dt>
          <dd>
            {formatNutrientValue(
              nutrients ? nutrients[field.key] : null,
              field.unit,
              field.decimals
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── one meal row ───────────────────────────────────────────────────────

function MealRow(props: { meal: Meal; key?: string }): ReactNodeLike {
  const meal = props.meal;
  return (
    <li className="fud-meal-row">
      <div className="fud-meal-main">
        <span className="fud-meal-time">
          {formatMealTime(meal.consumedAt, meal.timezoneOffset)}
        </span>
        <span className="fud-meal-desc">
          {meal.description}
          {meal.servingNote ? ` (${meal.servingNote})` : ""}
        </span>
        <span className="fud-meal-tags">
          <span className="fud-badge">{CAPTURE_KIND_LABEL[meal.captureKind]}</span>
          <span className="fud-badge">{ESTIMATE_STATE_LABEL[meal.estimateState]}</span>
        </span>
      </div>
      <NutrientList nutrients={meal.estimateState === "estimated" ? meal.nutrients : null} />
    </li>
  );
}

// ── daily totals ───────────────────────────────────────────────────────

function TotalsBlock(props: { totals: DailyTotals }): ReactNodeLike {
  const totals = props.totals;
  return (
    <div className="fud-totals">
      <div className="fud-totals-row">
        <span className="fud-badge">Estimated totals</span>
      </div>
      <NutrientList nutrients={totals.nutrients} />
      {totals.incomplete ? (
        <p className="fud-disclosure" role="note">
          {totals.mealsWithoutEstimate === 1
            ? "1 meal on this day has no completed estimate — totals may be incomplete."
            : `${totals.mealsWithoutEstimate} meals on this day have no completed estimate — totals may be incomplete.`}
        </p>
      ) : null}
    </div>
  );
}

// ── consent (read-only) ───────────────────────────────────────────────

interface ConsentResult extends Record<string, unknown> {
  granted: boolean;
  grantedAt: string | null;
}

function ConsentBanner(props: { query: QueryState<ConsentResult> }): ReactNodeLike {
  const query = props.query;
  if (query.status === "loading") {
    return (
      <div className="fud-consent" role="status">
        <span className="fud-badge">Consent: checking…</span>
      </div>
    );
  }
  const outcome = query.outcome;
  if (outcome.kind === "disabled") {
    return (
      <div className="fud-consent" role="status">
        <span className="fud-badge">Food is turned off on the server</span>
      </div>
    );
  }
  if (outcome.kind === "blocked" || outcome.kind === "error") {
    return (
      <div className="fud-consent" role="status">
        <span className="fud-badge">Consent: unavailable</span>
      </div>
    );
  }
  return (
    <div className="fud-consent" role="status">
      <span className="fud-badge">
        {outcome.result.granted
          ? "AI estimation consent: granted"
          : "AI estimation consent: not granted"}
      </span>
    </div>
  );
}

// ── root ───────────────────────────────────────────────────────────────

interface MealsListResult extends Record<string, unknown> {
  meals: Meal[];
  totals: DailyTotals | null;
}

export function Root(): ReactNodeLike {
  const [localDate, setLocalDate] = useState<string>(todayLocalDate());
  const mealsQuery = useToolQuery<MealsListResult>("food.meals.list", { localDate });
  const consentQuery = useToolQuery<ConsentResult>("food.consent.get", {});

  const onDateChange = useCallback((event: { target: { value: string } }) => {
    if (event.target.value) setLocalDate(event.target.value);
  }, []);

  return (
    <div className="fud-root">
      <header className="fud-header">
        <span className="fud-badge">Module</span>
        <h1>Food</h1>
      </header>
      <ConsentBanner query={consentQuery} />
      <div className="fud-datebar">
        <label htmlFor="fud-date-input">Date</label>
        <input id="fud-date-input" type="date" value={localDate} onChange={onDateChange} />
      </div>
      {renderMealsSection(mealsQuery)}
    </div>
  );
}

function renderMealsSection(query: QueryState<MealsListResult>): ReactNodeLike {
  if (query.status === "loading") {
    return (
      <div className="fud-state" role="status">
        <p>Loading…</p>
      </div>
    );
  }
  const outcome = query.outcome;
  if (outcome.kind === "disabled") {
    return (
      <div className="fud-state" role="status">
        <h2>Food is turned off</h2>
        <p>
          This module was disabled on the server. Your data is preserved; an administrator can
          re-enable it under Settings.
        </p>
      </div>
    );
  }
  if (outcome.kind === "blocked") {
    return (
      <div className="fud-state" role="status">
        <p>This data needs confirmation in the assistant.</p>
      </div>
    );
  }
  if (outcome.kind === "error") {
    return (
      <div className="fud-state" role="alert">
        <p>{outcome.message}</p>
      </div>
    );
  }
  const result = outcome.result;
  if (result.meals.length === 0) {
    return (
      <div className="fud-state" role="status">
        <h2>No meals logged for this day</h2>
        <p>Log a meal by talking to the assistant.</p>
      </div>
    );
  }
  return (
    <div className="fud-stack">
      <ul className="fud-meals">
        {result.meals.map((meal) => (
          <MealRow key={meal.mealId} meal={meal} />
        ))}
      </ul>
      {result.totals ? <TotalsBlock totals={result.totals} /> : null}
    </div>
  );
}
