import { AlertCircle, Calendar, Check, GitCommitHorizontal, PanelRight } from "lucide-react";
import { useState } from "react";

import {
  groupByPriority,
  localDay,
  type LocaleSettingsDto,
  type TaskApiStatus,
  type TaskDto,
  type TaskEffort,
  type TaskListDto
} from "@moss/shared";
import { Button } from "@moss/ui";

import { useAssistantName } from "../api/use-assistant-name.js";
import { formatDate, useUserLocale } from "../locale/locale-format.js";
import { effortLabels } from "./task-format.js";

/** Stable per-list dot colour (lists carry no colour of their own). */
const LIST_COLORS = [
  "var(--forest)",
  "var(--steel)",
  "var(--amber)",
  "var(--red)",
  "var(--ink-3)",
  "var(--forest-hover)"
];

/** Build a stable listId → {name, color} lookup shared by list + matrix views. */
export function listColorMap(
  lists: readonly TaskListDto[]
): Map<string, { name: string; color: string }> {
  return new Map(
    lists.map((list, index) => [
      list.id,
      { name: list.name, color: LIST_COLORS[index % LIST_COLORS.length] ?? "var(--forest)" }
    ])
  );
}

/** Priority value → criticality colour token (mirrors the design system ramp). */
function priorityColor(value: number | null): string {
  switch (value) {
    case 5:
      return "var(--priority-urgent)";
    case 4:
      return "var(--priority-high)";
    case 3:
      return "var(--priority-medium)";
    case 2:
      return "var(--priority-low)";
    case 1:
      return "var(--priority-minimal)";
    default:
      return "var(--priority-none)";
  }
}

const EFFORT_TICKS: Record<TaskEffort, number> = {
  quick: 1,
  medium: 2,
  large: 3
};

interface DueInfo {
  readonly label: string;
  readonly tone: "" | "overdue" | "today";
  readonly drift: "atrisk" | "overdue" | null;
  /** False only when the drift pill already reads "Overdue" (#1115) — avoids showing the
      icon/text badge and the pill at once for the same non-done overdue task. */
  readonly showBadge: boolean;
}

/** Due date → human label + drift signal (system-owned urgency, anti-shame amber).
    Day-bucketed in the user's persisted timezone (#579): the due date and "today" are
    compared as `YYYY-MM-DD` keys resolved in `locale.timezone`, never the ambient zone.
    Exported for unit coverage of the per-row badge's timezone bucketing. */
export function dueInfo(task: TaskDto, locale: LocaleSettingsDto): DueInfo | null {
  if (!task.dueAt) return null;
  const todayKey = localDay(new Date(), locale.timezone);
  const dueKey = localDay(task.dueAt, locale.timezone);
  const done = task.status === "done";

  if (dueKey < todayKey) {
    return { label: "Overdue", tone: "overdue", drift: done ? null : "overdue", showBadge: done };
  }
  if (dueKey === todayKey) {
    return { label: "Today", tone: "today", drift: null, showBadge: true };
  }
  const short = formatDate(task.dueAt, locale, { month: "short", day: "numeric" });
  // Both keys are user-zone `YYYY-MM-DD`, so they parse as UTC midnight and the delta is
  // exact integer days — free of ambient-zone drift.
  const driftDays =
    (Date.parse(`${dueKey}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000;
  const atRisk = !done && driftDays <= 2;
  return { label: short, tone: "", drift: atRisk ? "atrisk" : null, showBadge: true };
}

/** Single effort dot: empty = quick, left-half = medium, full = large (DS "fill" style). */
function EffortDot(props: { readonly effort: TaskEffort }) {
  const ticks = EFFORT_TICKS[props.effort];
  const title = `${effortLabels[props.effort]} effort`;
  return (
    <span className="tk-effort-fill" title={title} aria-label={title}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        {ticks === 3 ? <circle cx="7" cy="7" r="5.5" fill="currentColor" stroke="none" /> : null}
        {ticks === 2 ? <path d="M7 1.5 A5.5 5.5 0 0 0 7 12.5 Z" fill="currentColor" /> : null}
      </svg>
    </span>
  );
}

export function TaskListView(props: {
  readonly tasks: readonly TaskDto[];
  readonly lists: readonly TaskListDto[];
  readonly isUpdating: boolean;
  readonly onToggleDone: (task: TaskDto) => void;
  readonly onOpen: (task: TaskDto) => void;
  readonly onAccept?: (task: TaskDto) => void;
  readonly onDismiss?: (task: TaskDto) => void;
}) {
  const assistantName = useAssistantName();
  const groups = groupByPriority(props.tasks).filter((group) => group.tasks.length > 0);
  const listMeta = listColorMap(props.lists);
  const mossSourcedCount = props.tasks.filter(
    (task) => task.status !== "done" && isMossSource(task.source)
  ).length;

  if (groups.length === 0) {
    return null;
  }

  return (
    <div>
      {groups.map((group) => (
        <div className="tk-panel" key={group.value ?? "none"}>
          <div className="tk-panel__head">
            <span
              className="tk-panel__dot"
              style={{ "--tk-swatch": priorityColor(group.value) } as React.CSSProperties}
            />
            <span className="tk-panel__name">{group.label}</span>
            <span className="tk-panel__count">{group.tasks.length}</span>
          </div>
          <div className="tk-panel__body">
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                list={listMeta.get(task.listId)}
                isUpdating={props.isUpdating}
                onToggleDone={props.onToggleDone}
                onOpen={props.onOpen}
                onAccept={props.onAccept}
                onDismiss={props.onDismiss}
              />
            ))}
          </div>
        </div>
      ))}
      {mossSourcedCount > 0 ? (
        <div className="tk-foot">
          <span className="ic">
            <GitCommitHorizontal size={14} aria-hidden="true" />
          </span>
          {assistantName} is tracking {mossSourcedCount} {mossSourcedCount === 1 ? "task" : "tasks"}{" "}
          it created for you — all marked by source.
        </div>
      ) : null}
    </div>
  );
}

export function TaskRow(props: {
  readonly task: TaskDto;
  readonly list?: { readonly name: string; readonly color: string };
  readonly isUpdating: boolean;
  readonly compact?: boolean;
  readonly onToggleDone: (task: TaskDto) => void;
  readonly onOpen: (task: TaskDto) => void;
  readonly onAccept?: (task: TaskDto) => void;
  readonly onDismiss?: (task: TaskDto) => void;
}) {
  const { task, compact = false } = props;
  const assistantName = useAssistantName();
  const locale = useUserLocale();
  const [optimisticDone, setOptimisticDone] = useState(task.status === "done");
  const done = optimisticDone;
  const due = dueInfo(task, locale);
  const tags = compact ? [] : (task.tags ?? []);
  const mossSourced = !compact && isMossSource(task.source);
  const suggested = task.status === "suggested" && Boolean(props.onAccept && props.onDismiss);

  return (
    <div className={`tk-task ${done ? "tk-task--done" : ""}`}>
      <span
        className="tk-task__bar"
        style={{ "--tk-swatch": priorityColor(task.priority) } as React.CSSProperties}
      />
      <span className="tk-task__check">
        {suggested ? (
          <span className="tk-task__src" title={`Suggested by ${assistantName}`}>
            <GitCommitHorizontal size={13} aria-hidden="true" />
          </span>
        ) : (
          <label className="jds-check">
            <input
              type="checkbox"
              checked={done}
              disabled={props.isUpdating}
              onChange={() => {
                setOptimisticDone(!optimisticDone);
                props.onToggleDone(task);
              }}
              aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
            />
            <span className="jds-check__box">
              <Check size={13} aria-hidden="true" />
            </span>
          </label>
        )}
      </span>
      <button
        type="button"
        className="tk-task__main"
        onClick={() => props.onOpen(task)}
        aria-label={`Open ${task.title}`}
      >
        <span className="tk-task__title">{task.title}</span>
        <span className="tk-task__meta">
          {due?.showBadge ? (
            <span
              className={`tk-meta-due ${due.tone === "overdue" ? "tk-meta-due--overdue" : due.tone === "today" ? "tk-meta-due--today" : ""}`}
            >
              <span className="ic">
                {due.tone === "overdue" ? (
                  <AlertCircle size={12} aria-hidden="true" />
                ) : (
                  <Calendar size={12} aria-hidden="true" />
                )}
              </span>
              {due.label}
            </span>
          ) : null}
          {due?.drift ? (
            <span className={`jds-drift jds-drift--${due.drift}`}>
              <span className="jds-drift__dot" />
              {due.drift === "overdue" ? "Overdue" : "At risk"}
            </span>
          ) : null}
          {props.list ? (
            <span className="tk-listchip">
              <span
                className="tk-listchip__dot"
                style={{ "--tk-swatch": props.list.color } as React.CSSProperties}
              />
              {props.list.name}
            </span>
          ) : null}
          {tags.slice(0, 2).map((tag) => (
            <span className="tk-metatag" key={tag.id}>
              #{tag.name}
            </span>
          ))}
          {tags.length > 2 ? <span className="tk-metatag">+{tags.length - 2}</span> : null}
          {mossSourced ? (
            <span className="tk-task__src">
              <GitCommitHorizontal size={12} aria-hidden="true" />
              {task.source}
            </span>
          ) : null}
        </span>
      </button>
      <div className="tk-task__right">
        {suggested ? (
          <>
            <Button
              disabled={props.isUpdating}
              size="sm"
              variant="secondary"
              onClick={() => props.onAccept?.(task)}
            >
              Accept
            </Button>
            <Button
              disabled={props.isUpdating}
              size="sm"
              variant="quiet"
              onClick={() => props.onDismiss?.(task)}
            >
              Dismiss
            </Button>
          </>
        ) : null}
        {!compact && task.effort ? <EffortDot effort={task.effort} /> : null}
        <button
          type="button"
          className="tk-task__open"
          onClick={() => props.onOpen(task)}
          aria-label={`Open ${task.title}`}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** A task the assistant created carries a non-user source (chat, email, briefing, connector…). */
function isMossSource(source: string): boolean {
  const s = source.toLowerCase();
  return s !== "" && s !== "user" && s !== "manual";
}

export type { TaskApiStatus };
