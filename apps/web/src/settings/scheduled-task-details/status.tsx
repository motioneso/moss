import { Badge, Note } from "@moss/ui";
import type { ScheduledTaskState } from "@moss/shared";
import type { TaskDetailProps } from "./types";
const labels: Record<ScheduledTaskState, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  expired: "Expired",
  failed: "Failed",
  cancelled: "Cancelled"
};
export function TaskStatus({ task }: TaskDetailProps) {
  return (
    <>
      <div>
        <Badge
          tone={task.state === "failed" ? "red" : task.state === "active" ? "forest" : "neutral"}
        >
          {labels[task.state]}
        </Badge>
      </div>
      {task.state === "failed" && (
        <Note variant="practical">
          {task.destination
            ? `This task could not be sent to ${task.destination.title}. Ask Moss to set it again with an available chat or Main.`
            : "This reminder could not be sent. Ask Moss in Main chat to set it again."}
        </Note>
      )}
    </>
  );
}
