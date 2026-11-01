// external-modules/meals/src/web/screens/plan-day.tsx
//
// One day of the plan: its meals by slot, each with Safety already attached, or the reason the
// day or a meal could not be written. Read-only except the retry button, which needs the host's
// write handle.
import {
  Badge,
  Button,
  Eyebrow,
  Indicator,
  SectionHead,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { GenerationFailure, PlanDayView, PlannedMealView } from "../../contracts";
import { dayTitle, titleCase } from "../format";
import { navigate } from "../router";

const FAILURE_TEXT: Record<GenerationFailure, string> = {
  needs_config: "No AI model is set up for Moss yet.",
  provider_error: "The AI service had a problem.",
  usage_limited: "The AI service hit its usage limit.",
  validation_failed: "Moss got an answer it could not use.",
  aborted: "The run was interrupted.",
  safety_cap: "No option was safe for everyone who eats.",
  timeout: "It took too long to write.",
  stopped: "Writing stopped before this day."
};

export const failureText = (reason: GenerationFailure | null): string | null =>
  reason === null ? null : FAILURE_TEXT[reason];

/** A meal shows only once it is written and every eater's Safety result is known. */
function isShown(meal: PlannedMealView): boolean {
  return meal.status === "ready" && meal.eaters.every((eater) => eater.safety !== "pending");
}

function Recovery(props: {
  title: string;
  message: string | null;
  action?: ReactNodeLike;
}): ReactNodeLike {
  return (
    <div className="jds-recovery" role="alert">
      <div>
        <div className="jds-recovery__title">{props.title}</div>
        {props.message ? <div className="jds-recovery__msg">{props.message}</div> : null}
        {props.action ? <div className="jds-recovery__actions">{props.action}</div> : null}
      </div>
    </div>
  );
}

function Fit(props: { meal: PlannedMealView }): ReactNodeLike | null {
  const rows = props.meal.eaters.filter((eater) => eater.fit !== null);
  if (rows.length === 0) return null;
  return (
    <div className="mls-fit">
      {rows.map((eater) => {
        const fit = eater.fit!;
        const percent = Math.min(100, Math.round((fit.estimatedKcal / fit.targetKcal) * 100));
        return [
          <span
            className="mls-fit__name jds-caption"
            key={`${eater.memberId}-n`}
            title={eater.name}
          >
            {eater.name}
          </span>,
          <div
            key={`${eater.memberId}-m`}
            className={fit.band === "over" ? "jds-progress jds-progress--amber" : "jds-progress"}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={fit.targetKcal}
            aria-valuenow={fit.estimatedKcal}
            aria-label={`${eater.name}: ${fit.estimatedKcal} of ${fit.targetKcal} kcal`}
          >
            <div className="jds-progress__fill" style={{ width: `${percent}%` }} />
          </div>,
          <span className="mls-num jds-caption" key={`${eater.memberId}-v`}>
            {fit.estimatedKcal} / {fit.targetKcal}
          </span>
        ];
      })}
    </div>
  );
}

function Safety(props: { meal: PlannedMealView }): ReactNodeLike | null {
  const failed = props.meal.eaters.filter((eater) => eater.safety === "fail");
  const reasons = props.meal.eaters.flatMap((eater) =>
    eater.safetyReason ? [`${eater.name}: ${eater.safetyReason}`] : []
  );
  if (failed.length === 0 && props.meal.checkLabelCount === 0) return null;
  const lead =
    failed.length > 0
      ? `Not safe for ${failed.map((eater) => eater.name).join(" and ")}.`
      : props.meal.checkLabelCount === 1
        ? "Check the label on 1 ingredient."
        : `Check the label on ${props.meal.checkLabelCount} ingredients.`;
  return (
    <p className="mls-safety jds-caption">
      {lead}
      {reasons.length > 0 ? ` ${reasons.join(". ")}` : ""}
    </p>
  );
}

function Meal(props: { meal: PlannedMealView }): ReactNodeLike {
  const { meal } = props;
  if (meal.status === "failed") {
    return (
      <div className="mls-meal">
        <Recovery title="No meal yet" message={failureText(meal.failureReason)} />
      </div>
    );
  }
  if (!isShown(meal)) {
    return (
      <div className="mls-meal" role="status">
        <span className="mls-writing">
          <Indicator
            status={meal.status === "writing" ? "ready" : "idle"}
            live={meal.status === "writing"}
            label={meal.status === "writing" ? "Writing" : "Waiting"}
          />
        </span>
      </div>
    );
  }
  const servings = meal.servings;
  return (
    <article className="mls-meal">
      {meal.kind === "recipe" && meal.title !== null ? (
        <a
          className="mls-meal__title"
          href={`/m/meals/recipe/${meal.mealId}`}
          onClick={(event: { preventDefault: () => void }) => {
            event.preventDefault();
            navigate(`/recipe/${meal.mealId}`);
          }}
        >
          {meal.title}
        </a>
      ) : (
        <p className="mls-meal__text">{meal.plainText}</p>
      )}
      <Fit meal={meal} />
      <Safety meal={meal} />
      <p className="mls-meal__meta jds-caption">
        {meal.eaters.length > 0 ? (
          <span>{meal.eaters.map((eater) => eater.name).join(", ")}</span>
        ) : null}
        <span>Serves {servings % 1 === 0 ? servings : servings.toFixed(1)}</span>
        {meal.cookMinutes !== null ? <span>{meal.cookMinutes}&nbsp;min</span> : null}
      </p>
    </article>
  );
}

function slotGroups(meals: readonly PlannedMealView[]): [string, PlannedMealView[]][] {
  const groups = new Map<string, PlannedMealView[]>();
  for (const meal of meals) groups.set(meal.slotName, [...(groups.get(meal.slotName) ?? []), meal]);
  return [...groups.entries()];
}

export function DaySection(props: {
  day: PlanDayView;
  index: number;
  today: string;
  planActive: boolean;
  showSharing: boolean;
  onRetry: (() => void) | null;
}): ReactNodeLike {
  const { day, today } = props;
  const isToday = day.date === today;
  const number = String(props.index + 1).padStart(2, "0");

  let meta: ReactNodeLike = null;
  if (day.status === "writing") meta = <Indicator status="ready" live label="Writing" />;
  else if (day.status === "pending" && props.planActive)
    meta = <Indicator status="idle" label="Waiting" />;
  else if (day.status === "pending") meta = <span className="jds-caption">Not written</span>;
  else if (isToday) meta = <Badge tone="forest">Today</Badge>;

  const head = (
    <SectionHead number={number} title={dayTitle(day.date)} meta={meta} titleAs="h3" wrap />
  );
  const className = isToday ? "mls-day mls-day--today" : "mls-day";

  if (day.status === "failed") {
    const message = failureText(day.failureReason);
    return (
      <section className={className} aria-label={dayTitle(day.date)}>
        {head}
        <Recovery
          title={`Moss could not finish ${dayTitle(day.date).split(",")[0]}`}
          message={message}
          action={
            props.onRetry ? (
              <Button variant="secondary" size="sm" onClick={props.onRetry}>
                Retry
              </Button>
            ) : null
          }
        />
      </section>
    );
  }

  const groups = slotGroups(day.meals);
  const totals = day.dayFit.flatMap((entry) => {
    const name = day.meals
      .flatMap((meal) => meal.eaters)
      .find((e) => e.memberId === entry.memberId)?.name;
    return name ? [{ name, fit: entry.fit }] : [];
  });

  return (
    <section className={className} aria-label={dayTitle(day.date)}>
      {head}
      {totals.length > 0 ? (
        <div className="mls-day__totals">
          {totals.map((entry) => (
            <span className="jds-caption" key={entry.name}>
              <strong>{entry.name}</strong>{" "}
              <span className="mls-num">
                {entry.fit.estimatedKcal.toLocaleString("en-US")} of{" "}
                {entry.fit.targetKcal.toLocaleString("en-US")}&nbsp;kcal
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {groups.length > 0 ? (
        <div
          className="mls-slots"
          style={{ "--mls-slot-count": groups.length } as Record<string, number>}
        >
          {groups.map(([slot, meals]) => (
            <div className="mls-slot" key={slot}>
              <div className="mls-slot__label">
                <Eyebrow>{titleCase(slot)}</Eyebrow>
                {props.showSharing ? (
                  <span className="jds-caption">
                    {meals.length > 1 || meals[0]?.sharing === "solo" ? "Solo" : "Shared"}
                  </span>
                ) : null}
              </div>
              {meals.map((meal) => (
                <Meal meal={meal} key={meal.mealId} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
