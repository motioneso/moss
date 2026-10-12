import type { TaskDetailProps } from "./types";
export function TaskInstruction({ task }: TaskDetailProps) {
  return <p>{task.instruction}</p>;
}
