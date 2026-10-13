import { RowIndex, RowIndexItem } from "@moss/ui";
import { formatDateTime } from "../../locale/locale-format";
import { isPastTask, type TaskDetailProps } from "./types";
export function TaskTiming({ task, locale }: TaskDetailProps) {
  if (isPastTask(task) || task.state === "failed") return null;
  return (
    <RowIndex variant="facts" density="compact">
      {task.schedule && <RowIndexItem title="Schedule" meta={task.schedule} />}
      <RowIndexItem
        title={task.schedule ? "Next reminder" : "Schedule"}
        meta={formatDateTime(task.dueAt, locale)}
      />
      {(task.group === "Daily" || task.group === "Weekly") && (
        <RowIndexItem
          title="When clocks change"
          meta="A skipped local time moves forward by the gap. A repeated local time fires once, at its earlier occurrence."
        />
      )}
      {task.deadlineAt && (
        <RowIndexItem title="Not after" meta={formatDateTime(task.deadlineAt, locale)} />
      )}
    </RowIndex>
  );
}
