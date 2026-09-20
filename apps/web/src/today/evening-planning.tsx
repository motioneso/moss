import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BriefingRunDto,
  CalendarEventDto,
  DayPlanTaskSummary,
  LocaleSettingsDto,
  TaskDto
} from "@moss/shared";

import { Button } from "@moss/ui";

import { isAtRisk } from "../tasks/focus.js";
import { BriefingDialog } from "./briefing-dialog.js";
import { DayPlanSection } from "./day-plan.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import { buildEveningLede } from "./evening-mode.js";
import { EVENING_STEP_NAMES, SAVE_TOMORROW_LABEL } from "./today-labels.js";
import type { EveningPlanningController } from "./evening-planning-controller.js";
import { ReviewSection } from "./evening-planning-review.js";
import { CommitSection, ReflectStep, ShapeSection } from "./evening-planning-sections.js";
import {
  EVENING_STEP_IDS,
  EveningRail,
  EveningStepPanel,
  EveningStepStrip,
  type EveningStepId
} from "./evening-planning-frame.js";

export interface EveningPlanningDialogProps {
  readonly evening: EveningPlanningController;
  readonly review: DayPlanReviewController;
  readonly tasks: readonly TaskDto[];
  readonly taskSummaries: readonly DayPlanTaskSummary[];
  readonly unavailableTaskIds: readonly string[];
  readonly tomorrowEvents: readonly CalendarEventDto[];
  readonly completedToday: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly tomorrowKey: string;
  readonly eveningRun: BriefingRunDto | null;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
}

function summaryFor(taskId: string, tasks: readonly TaskDto[]): DayPlanTaskSummary | undefined {
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task) return undefined;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: task.dueAt,
    doAt: task.doAt,
    effort: task.effort
  };
}

/** Step ids in strip order; the frame opens on step 1 after every reload. */
const STEP_IDS: readonly EveningStepId[] = EVENING_STEP_IDS;

function headingIdFor(step: number): string {
  if (step === 0) return "evening-step-reflect-heading";
  return `evening-${STEP_IDS[step]}-heading`;
}

/** Evening planning dialog: one step at a time in the report chrome. */
export function EveningPlanningDialog(props: EveningPlanningDialogProps) {
  const { evening, review } = props;
  const [step, setStep] = useState(0);
  const prevStepRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevStepRef.current === null) {
      prevStepRef.current = step;
      return;
    }
    if (prevStepRef.current === step) {
      return;
    }
    prevStepRef.current = step;
    const heading = document.getElementById(headingIdFor(step));
    (heading ?? document.getElementById(`evening-panel-${STEP_IDS[step]}`))?.focus();
  }, [step]);
  const summaries = useMemo(() => {
    const known = new Map(props.taskSummaries.map((entry) => [entry.id, entry]));
    for (const task of props.tasks) {
      if (!known.has(task.id)) {
        const found = summaryFor(task.id, props.tasks);
        if (found) known.set(task.id, found);
      }
    }
    return [...known.values()];
  }, [props.taskSummaries, props.tasks]);
  const reflectTasks = useMemo(() => {
    const seen = new Set(props.completedToday.map((task) => task.id));
    const open = evening.rows
      .filter((row) => row.marked === null && row.task.status === "todo")
      .map((row) => row.task)
      .filter((task) => {
        if (seen.has(task.id)) return false;
        seen.add(task.id);
        return true;
      });
    return [...props.completedToday, ...open];
  }, [props.completedToday, evening.rows]);
  const committed = useMemo(
    () =>
      evening.rows
        .filter(
          (row) =>
            row.marked === null &&
            (evening.decisions[row.task.id]?.decision ?? row.decided) === "tomorrow"
        )
        .map((row) => row.task),
    [evening.rows, evening.decisions]
  );
  const ledeHtml = useMemo(
    () =>
      buildEveningLede(
        props.completedToday.length,
        props.tasks.filter(
          (task) =>
            task.parentTaskId === null &&
            task.status === "todo" &&
            isAtRisk(task, props.locale.timezone)
        ).length,
        props.tomorrowEvents.length
      ),
    [props.completedToday, props.tasks, props.tomorrowEvents, props.locale.timezone]
  );
  const summaryText = props.eveningRun?.summaryText.trim() ? props.eveningRun.summaryText : null;
  const stepId = STEP_IDS[step]!;
  const stepName = EVENING_STEP_NAMES[step]!;
  return (
    <BriefingDialog
      title="Plan tomorrow"
      eyebrow="Moss / Evening planning"
      variant="report"
      opener={props.opener}
      onClose={props.onClose}
      nav={<EveningStepStrip names={[...EVENING_STEP_NAMES]} active={step} onSelect={setStep} />}
      footer={
        <>
          <div className="brief-reader__footer-back">
            <Button variant="secondary" onClick={props.onClose}>
              Back to Today
            </Button>
          </div>
          <span
            className={`evening-plan__status${evening.status !== "Not saved yet." ? " evening-plan__status--saved" : ""}`}
            role="status"
          >
            {evening.status}
          </span>
          {evening.reviewNotice ? (
            <span className="evening-plan__notice" role="status">
              {evening.reviewNotice}
            </span>
          ) : null}
          <div className="brief-reader__footer-actions">
            {step < 3 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)}>
                {`Next: ${EVENING_STEP_NAMES[step + 1]}`}
              </Button>
            ) : (
              <Button variant="primary" disabled={evening.busy} onClick={() => void evening.save()}>
                {SAVE_TOMORROW_LABEL}
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className="evening-plan__grid">
        <EveningStepPanel
          stepId={stepId}
          headingId={summaryText === null && step === 0 ? undefined : headingIdFor(step)}
          label={stepName}
        >
          {step === 0 ? (
            <ReflectStep
              evening={evening}
              tasks={reflectTasks}
              locale={props.locale}
              headingId={headingIdFor(0)}
              ledeHtml={ledeHtml}
              summaryText={summaryText}
            />
          ) : step === 1 ? (
            <CommitSection
              evening={evening}
              rows={evening.rows}
              tomorrowKey={props.tomorrowKey}
              timeZone={props.locale.timezone}
            />
          ) : step === 2 ? (
            <ShapeSection
              evening={evening}
              committed={committed}
              tasks={props.tasks}
              locale={props.locale}
            />
          ) : (
            <ReviewSection
              evening={evening}
              review={review}
              plan={evening.plan}
              rows={evening.rows}
              summaries={summaries}
              unavailableTaskIds={props.unavailableTaskIds}
              tomorrowEvents={props.tomorrowEvents}
              locale={props.locale}
              now={props.now}
              onOpenTask={props.onOpenTask}
            />
          )}
        </EveningStepPanel>
        <EveningRail
          railDateInput={`${props.tomorrowKey}T12:00:00Z`}
          locale={props.locale}
          summary="Tomorrow's plan"
        >
          {evening.plan ? (
            <DayPlanSection
              dayPlan={{
                plan: evening.plan,
                tasks: [...summaries],
                unavailableTaskIds: [...props.unavailableTaskIds],
                sourceRun: null,
                sourceRunUnavailable: false
              }}
              events={props.tomorrowEvents}
              locale={props.locale}
              now={props.now}
              loading={false}
              error={false}
              calendarError={false}
              onOpenTask={props.onOpenTask}
              targetDayKey={props.tomorrowKey}
            />
          ) : (
            <p className="cmd-empty">Nothing saved for tomorrow yet.</p>
          )}
        </EveningRail>
      </div>
    </BriefingDialog>
  );
}
