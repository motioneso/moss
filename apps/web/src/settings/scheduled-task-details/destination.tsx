import type { TaskDetailProps } from "./types";
export function TaskDestination({ task }: TaskDetailProps) {
  return task.destination ? <p>Send results to {task.destination.title}</p> : null;
}
