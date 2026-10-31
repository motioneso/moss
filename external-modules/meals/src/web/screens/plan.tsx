// external-modules/meals/src/web/screens/plan.tsx
//
// The Plan area: tonight's dinner, then the plan day by day as Moss writes it. Stop, resume and
// retry show only with the host's write handle.
import {
  Badge,
  Button,
  EmptyState,
  Masthead,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { PantryMode, PlanView } from "../../contracts";
import { dateRange, todayIso } from "../format";
import { isWriting, type PlanState } from "../plan";
import type { MealsWrites } from "../writes";
import type { HostActions } from "../root";
import { DaySection } from "./plan-day";

const PANTRY_LABEL: Record<PantryMode, string> = {
  ignore: "Ignore the Pantry",
  prefer: "Prefer what's on hand",
  only: "Only what's on hand"
};

const PAUSE_TEXT = {
  invocation: "Moss hit its limit for work started from one request.",
  pending: "Moss has too much waiting to write.",
  hourly: "Moss hit its hourly limit for background writing."
} as const;

export function PlanScreen(props: {
  state: PlanState;
  reload: () => void;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state } = props;
  if (state.kind === "loading") {
    return (
      <p className="jds-caption" role="status">
        Loading your plan
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="jds-recovery" role="alert">
        <div>
          <div className="jds-recovery__title">Couldn't load your plan</div>
          <div className="jds-recovery__msg">Check the connection, then try again.</div>
          <div className="jds-recovery__actions">
            <Button variant="secondary" size="sm" onClick={props.reload}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (state.kind === "empty") {
    return (
      <EmptyState title="Plan your first week">
        <Button
          onClick={() =>
            props.hostActions.openAssistant({ starterPrompt: "Plan my meals for the next week" })
          }
        >
          Plan with Moss
        </Button>
      </EmptyState>
    );
  }
  return <Plan {...props} plan={state.plan} />;
}

function tonight(plan: PlanView, today: string) {
  const dinner = plan.days
    .find((day) => day.date === today)
    ?.meals.find(
      (meal) =>
        meal.slotName === "dinner" &&
        meal.status === "ready" &&
        meal.title !== null &&
        meal.eaters.every((eater) => eater.safety !== "pending")
    );
  return dinner ?? null;
}

function Plan(props: {
  plan: PlanView;
  reload: () => void;
  writes: MealsWrites | null;
}): ReactNodeLike {
  const { plan, writes } = props;
  const today = todayIso();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const writing = isWriting(plan);
  const last = plan.days[plan.days.length - 1]?.date ?? plan.startDate;
  const range = dateRange(plan.startDate, last);
  const dinner = tonight(plan, today);
  const people = new Set(
    plan.days.flatMap((day) => day.meals.flatMap((m) => m.eaters.map((e) => e.memberId)))
  );

  async function control(input: Record<string, unknown>) {
    if (writes === null || busy) return;
    setBusy(true);
    setFailed(false);
    const outcome = await writes.invoke("meals.plan.control", { planId: plan.planId, ...input });
    setBusy(false);
    if (outcome.kind === "failed" || outcome.kind === "rejected") setFailed(true);
    props.reload();
  }

  const done = plan.progress.ready;
  const total = plan.progress.total;
  const current =
    plan.days.find((day) => day.status === "writing") ??
    plan.days.find((d) => d.status === "pending");

  return (
    <div className="mls-stack">
      {writing ? (
        <Masthead tone="field" eyebrow={`${range} · Moss is writing`} title="Writing your plan" />
      ) : dinner !== null ? (
        <Masthead
          tone="field"
          eyebrow="Tonight · Dinner"
          title={dinner.title}
          lede={`${dinner.cookMinutes !== null ? `${dinner.cookMinutes} minutes, for ` : "For "}${dinner.eaters.map((e) => e.name).join(" and ")}.`}
        />
      ) : null}

      <div className="mls-planbar">
        <div className="mls-row">
          <strong className="mls-num">{range}</strong>
          <Badge outline>{PANTRY_LABEL[plan.pantryMode]}</Badge>
        </div>
        {writing ? (
          <div className="mls-progress">
            <span className="jds-caption" role="status">
              {current ? `Writing day ${plan.days.indexOf(current) + 1}, ` : ""}
              {done} of {total} days done
            </span>
            <div
              className="jds-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-label="Days written"
            >
              <div
                className="jds-progress__fill"
                style={{ width: `${Math.round((done / Math.max(total, 1)) * 100)}%` }}
              />
            </div>
            {writes !== null ? (
              <Button
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={() => control({ action: "stop" })}
              >
                Stop
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {plan.state !== "active" && plan.days.some((day) => day.status === "pending") ? (
        <div className="jds-recovery" role="status">
          <div>
            <div className="jds-recovery__title">
              {plan.state === "stopped" ? "Writing stopped" : "Writing paused"}
            </div>
            <div className="jds-recovery__msg">
              {plan.state === "paused" && plan.pausedReason !== null
                ? PAUSE_TEXT[plan.pausedReason]
                : `${done} of ${total} days are written.`}
            </div>
            {writes !== null ? (
              <div className="jds-recovery__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => control({ action: "resume" })}
                >
                  Resume
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {failed ? (
        <p className="jds-caption" role="alert">
          That did not go through. Try again.
        </p>
      ) : null}

      <div className="mls-week">
        {plan.days.map((day, index) => (
          <DaySection
            key={day.dayId}
            day={day}
            index={index}
            today={today}
            planActive={plan.state === "active"}
            showSharing={people.size > 1}
            onRetry={
              writes !== null ? () => control({ action: "retry_day", dayId: day.dayId }) : null
            }
          />
        ))}
      </div>
    </div>
  );
}
