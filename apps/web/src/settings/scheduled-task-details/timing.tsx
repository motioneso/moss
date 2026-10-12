import { RowIndex, RowIndexItem } from "@moss/ui";
import { formatDateTime } from "../../locale/locale-format";
import { isPastTask, type TaskDetailProps } from "./types";
export function TaskTiming({ task, locale }: TaskDetailProps) {
  if (isPastTask(task) || task.state === "failed") return null;
  return (
    <RowIndex variant="facts" density="compact">
      <RowIndexItem title="Schedule" meta={formatDateTime(task.dueAt, locale)} />
      {task.deadlineAt && (
        <RowIndexItem title="Not after" meta={formatDateTime(task.deadlineAt, locale)} />
      )}
    </RowIndex>
  );
}
