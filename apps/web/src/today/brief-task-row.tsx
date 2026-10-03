import { Check, GitCommitHorizontal } from "lucide-react";
import { useState } from "react";

import { RowButton } from "@moss/ui";
import type { TaskDto } from "@moss/shared";

import { useUserLocale } from "../locale/locale-format";
import { driftOf, shortDate } from "./today-labels";

export function BriefTaskRow(props: {
  readonly task: TaskDto;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
}) {
  const { task } = props;
  const locale = useUserLocale();
  const [optimisticDone, setOptimisticDone] = useState(task.status === "done");
  const done = optimisticDone;
  const drift = driftOf(task, locale.timezone);
  const p1 = (task.priority ?? 0) >= 4;
  const captureParts = [`Task: ${task.title}`, done ? "done" : "open"];
  if (drift) captureParts.push(drift === "overdue" ? "overdue" : "at risk");
  if (task.dueAt) captureParts.push(`due ${shortDate(task.dueAt, locale)}`);
  captureParts.push(`source ${task.source}`);
  return (
    <div
      className={`jds-task ${p1 ? "jds-task--p1" : "jds-task--p2"} ${done ? "jds-task--done" : ""}`}
      data-jarvis-capture-text={captureParts.join(" — ")}
    >
      <span className="jds-task__prio" />
      <span className="jds-task__check">
        <label className="jds-check">
          <input
            type="checkbox"
            checked={done}
            onChange={() => {
              setOptimisticDone(!optimisticDone);
              props.onToggle();
            }}
            aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          />
          <span className="jds-check__box">
            <Check size={13} aria-hidden="true" />
          </span>
        </label>
      </span>
      <RowButton className="jds-task__main" onClick={props.onOpen}>
        <div className="jds-task__title">{task.title}</div>
        <div className="jds-task__meta">
          {drift ? (
            <span className={`jds-drift jds-drift--${drift}`}>
              <span className="jds-drift__dot" />
              {drift === "overdue" ? "Overdue" : "At risk"}
            </span>
          ) : null}
          <span className="jds-task__source">
            <GitCommitHorizontal size={12} aria-hidden="true" />
            {task.source}
          </span>
          {task.dueAt ? (
            <span className="jds-task__time">{shortDate(task.dueAt, locale)}</span>
          ) : null}
        </div>
      </RowButton>
    </div>
  );
}
