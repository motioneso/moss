import { TaskControls } from "./scheduled-task-details/controls";
import { useEffect, useRef } from "react";
import { Button } from "@moss/ui";
import type { ScheduledTaskDto } from "@moss/shared";
import { useUserLocale } from "../locale/locale-format";
import { TaskInstruction } from "./scheduled-task-details/instruction";
import { TaskDestination } from "./scheduled-task-details/destination";
import { TaskStatus } from "./scheduled-task-details/status";
import { TaskTiming } from "./scheduled-task-details/timing";
import { TaskHistory } from "./scheduled-task-details/history";
const pieces = [
  { id: "status", Component: TaskStatus },
  { id: "instruction", Component: TaskInstruction },
  { id: "timing", Component: TaskTiming },
  { id: "destination", Component: TaskDestination },
  { id: "history", Component: TaskHistory },
  { id: "controls", Component: TaskControls }
];
export function ScheduledTaskDetail({
  task,
  onBack
}: {
  readonly task: ScheduledTaskDto;
  readonly onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const locale = useUserLocale();
  useEffect(() => {
    heading.current?.focus();
  }, [task.id]);
  return (
    <div className="scheduled-task-detail">
      <Button variant="link" onClick={onBack}>
        Back to all tasks
      </Button>
      <h3 ref={heading} tabIndex={-1}>
        {task.title}
      </h3>
      {pieces.map(({ id, Component }) => (
        <Component key={id} task={task} locale={locale} onDeleted={onBack} />
      ))}
    </div>
  );
}
