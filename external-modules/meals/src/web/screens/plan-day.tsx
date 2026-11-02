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
  Select,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { GenerationFailure, PlanDayView, PlannedMealView } from "../../contracts";
import { isReplaceable } from "../../domain/regenerate";
import { dayTitle, titleCase } from "../format";
import { navigate } from "../router";

const FAILURE_TEXT: Record<GenerationFailure, string> = {
  needs_config: "No AI model is set up for Moss yet.",
  provider_error: "The AI service had a problem.",
  usage_limited: "The AI service hit its usage limit.",
  validation_failed: "Moss got an answer it could not use.",
  aborted: "The run was interrupted.",
  safety_cap:
    "Every option had something from an eater's Never serve list. Double check before you cook anything.",
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

/** What a meal's buttons do. Null hides every button (no write handle). */
export interface MealActions {
  readonly busy: boolean;
  lock(meal: PlannedMealView): void;
  unlock(meal: PlannedMealView): void;
  swap(meal: PlannedMealView): void;
  move(meal: PlannedMealView): void;
  eaters(meal: PlannedMealView): void;
  text(meal: PlannedMealView): void;
  regenerateMeal(meal: PlannedMealView): void;
  regenerateDay(day: PlanDayView): void;
}

/** What a day's arrange controls do. Null hides them (no write handle). */
export interface DayActions {
  readonly busy: boolean;
  cookLimit(day: PlanDayView, minutes: number | null): void;
  sharing(day: PlanDayView, slotName: string, sharing: "shared" | "solo"): void;
  oneOff(day: PlanDayView, slotName: string, memberId: string): void;
}

function MealTools(props: { meal: PlannedMealView; actions: MealActions }): ReactNodeLike | null {
  const { meal, actions } = props;
  if (meal.cookedAt !== null) return null;
  if (meal.kind === "text") {
    return (
      <div className="mls-meal__tools">
        <Button
          variant="quiet"
          size="sm"
          disabled={actions.busy}
          onClick={() => actions.text(meal)}
        >
          Text
        </Button>
      </div>
    );
  }
  if (meal.kind !== "recipe") return null;
  return (
    <div className="mls-meal__tools">
      <Button
        variant="quiet"
        size="sm"
        disabled={actions.busy}
        onClick={() => (meal.locked ? actions.unlock(meal) : actions.lock(meal))}
      >
        {meal.locked ? "Unlock" : "Lock"}
      </Button>
      <Button variant="quiet" size="sm" disabled={actions.busy} onClick={() => actions.swap(meal)}>
        Swap
      </Button>
      <Button variant="quiet" size="sm" disabled={actions.busy} onClick={() => actions.move(meal)}>
        Move
      </Button>
      <Button
        variant="quiet"
        size="sm"
        disabled={actions.busy}
        onClick={() => actions.eaters(meal)}
      >
        Eaters
      </Button>
      <Button variant="quiet" size="sm" disabled={actions.busy} onClick={() => actions.text(meal)}>
        Text
      </Button>
      {isReplaceable(meal) ? (
        <Button
          variant="quiet"
          size="sm"
          disabled={actions.busy}
          onClick={() => actions.regenerateMeal(meal)}
        >
          Regenerate
        </Button>
      ) : null}
    </div>
  );
}

const DOUBLE_CHECK = "Always double check.";

function Safety(props: { meal: PlannedMealView }): ReactNodeLike | null {
  const failed = props.meal.eaters.filter((eater) => eater.safety === "fail");
  const reasons = props.meal.eaters.flatMap((eater) =>
    eater.safetyReason ? [`${eater.name}: ${eater.safetyReason}`] : []
  );
  const checked = props.meal.eaters.some((eater) => eater.safety === "pass");
  if (failed.length === 0 && !checked && props.meal.checkLabelCount === 0) return null;
  const lead =
    failed.length > 0
      ? `Found something from the Never serve list for ${failed.map((eater) => eater.name).join(" and ")}.`
      : "Nothing from the Never serve list was found outright.";
  const label =
    props.meal.checkLabelCount === 0
      ? ""
      : props.meal.checkLabelCount === 1
        ? " Check the label on 1 ingredient."
        : ` Check the label on ${props.meal.checkLabelCount} ingredients.`;
  return (
    <p className="mls-safety jds-caption">
      {lead}
      {reasons.length > 0 ? ` ${reasons.join(". ")}` : ""}
      {label} {DOUBLE_CHECK}
    </p>
  );
}

function Meal(props: { meal: PlannedMealView; actions: MealActions | null }): ReactNodeLike {
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
        <div className="mls-row">
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
          {meal.locked ? <Badge outline>Locked</Badge> : null}
        </div>
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
      {props.actions !== null ? <MealTools meal={meal} actions={props.actions} /> : null}
    </article>
  );
}

function slotGroups(meals: readonly PlannedMealView[]): [string, PlannedMealView[]][] {
  const groups = new Map<string, PlannedMealView[]>();
  for (const meal of meals) groups.set(meal.slotName, [...(groups.get(meal.slotName) ?? []), meal]);
  return [...groups.entries()];
}

const COOK_LIMITS = [15, 20, 30, 45, 60, 90, 120] as const;

function DayTools(props: { day: PlanDayView; actions: DayActions }): ReactNodeLike {
  const { day, actions } = props;
  const people = new Map<string, string>();
  for (const meal of day.meals) {
    for (const eater of meal.eaters) people.set(eater.memberId, eater.name);
  }
  const slots = [...new Set(day.meals.map((meal) => meal.slotName))];
  const [slot, setSlot] = useState(slots[0] ?? "dinner");
  const [member, setMember] = useState([...people.keys()][0] ?? "");
  return (
    <div className="mls-row">
      <Select
        aria-label="Cook-time limit"
        value={day.cookTimeLimitMinutes === null ? "" : String(day.cookTimeLimitMinutes)}
        disabled={actions.busy}
        onChange={(event: { target: { value: string } }) =>
          actions.cookLimit(day, event.target.value === "" ? null : Number(event.target.value))
        }
      >
        <option value="">No cook-time limit</option>
        {COOK_LIMITS.map((minutes) => (
          <option key={minutes} value={minutes}>
            {minutes} min limit
          </option>
        ))}
        {day.cookTimeLimitMinutes !== null &&
        !(COOK_LIMITS as readonly number[]).includes(day.cookTimeLimitMinutes) ? (
          <option value={day.cookTimeLimitMinutes}>{day.cookTimeLimitMinutes} min limit</option>
        ) : null}
      </Select>
      {slots.length > 0 && people.size > 0 ? (
        <>
          <Select
            aria-label="One-off meal slot"
            value={slot}
            disabled={actions.busy}
            onChange={(event: { target: { value: string } }) => setSlot(event.target.value)}
          >
            {slots.map((name) => (
              <option key={name} value={name}>
                {titleCase(name)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="One-off meal for"
            value={member}
            disabled={actions.busy}
            onChange={(event: { target: { value: string } }) => setMember(event.target.value)}
          >
            {[...people.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          <Button
            variant="quiet"
            size="sm"
            disabled={actions.busy || member === ""}
            onClick={() => actions.oneOff(day, slot, member)}
          >
            Add One-off
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function DaySection(props: {
  day: PlanDayView;
  index: number;
  today: string;
  planActive: boolean;
  showSharing: boolean;
  onRetry: (() => void) | null;
  actions: MealActions | null;
  dayActions?: DayActions | null;
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

  const canRegenerate =
    props.actions !== null && day.status === "ready" && day.meals.some(isReplaceable);
  if (canRegenerate && meta === null) {
    meta = (
      <Button
        variant="quiet"
        size="sm"
        disabled={props.actions!.busy}
        onClick={() => props.actions!.regenerateDay(day)}
      >
        Regenerate day
      </Button>
    );
  } else if (canRegenerate) {
    meta = (
      <span className="mls-row">
        {meta}
        <Button
          variant="quiet"
          size="sm"
          disabled={props.actions!.busy}
          onClick={() => props.actions!.regenerateDay(day)}
        >
          Regenerate day
        </Button>
      </span>
    );
  }

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
      {props.dayActions ? <DayTools day={day} actions={props.dayActions} /> : null}
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
                {props.dayActions ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={props.dayActions.busy}
                    onClick={() =>
                      props.dayActions!.sharing(
                        day,
                        slot,
                        meals.length > 1 || meals[0]?.sharing === "solo" ? "shared" : "solo"
                      )
                    }
                  >
                    {meals.length > 1 || meals[0]?.sharing === "solo" ? "Make Shared" : "Make Solo"}
                  </Button>
                ) : null}
              </div>
              {meals.map((meal) => (
                <Meal meal={meal} key={meal.mealId} actions={props.actions} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
