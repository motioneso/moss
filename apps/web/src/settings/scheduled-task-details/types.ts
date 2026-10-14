import type { LocaleSettingsDto, ScheduledTaskDto } from "@moss/shared";
export interface TaskDetailProps {
  readonly task: ScheduledTaskDto;
  readonly onDeleted?: () => void;
  readonly locale: LocaleSettingsDto;
}
export function isPastTask(task: ScheduledTaskDto): boolean {
  return task.state === "completed" || task.state === "expired" || task.state === "cancelled";
}
