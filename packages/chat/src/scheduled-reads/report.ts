import type { GatewayToolResponse } from "@moss/ai";

export interface ScheduledTaskSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export function readScheduledTask(
  response: GatewayToolResponse,
  itemId: string
): ScheduledTaskSnapshot | null {
  if (!response.ok) return null;
  const task = response.structuredData?.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  const fields = Object.entries(task);
  const value = (key: string) => fields.find(([name]) => name === key)?.[1];
  const title = value("title");
  const status = value("status");
  if (
    value("id") !== itemId ||
    typeof title !== "string" ||
    title.length > 500 ||
    typeof status !== "string" ||
    !["todo", "suggested", "done", "archived"].includes(status)
  )
    return null;
  return { id: itemId, title, status };
}

export function renderScheduledReport(output: unknown, task: ScheduledTaskSnapshot): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const fields = Object.entries(output);
  const value = (key: string) => fields.find(([name]) => name === key)?.[1];
  const summary = value("summary");
  if (
    fields.length !== 3 ||
    value("taskId") !== task.id ||
    value("status") !== task.status ||
    typeof summary !== "string" ||
    !summary.trim() ||
    summary.length > 600
  )
    return null;
  const escaped = summary
    .trim()
    .replace(/[\\`*_{}[\]()<>!#|~]/g, "\\$&")
    .replace(/[\r\n]/g, " ");
  return `${escaped}\n\n[Source: Tasks](/tasks)`;
}

export const SCHEDULED_READ_REFUSED =
  "I couldn't check that task because access is no longer available. Choose a task you own in Tasks, then ask for a new check.";
export const SCHEDULED_READ_FAILED =
  "I couldn't read that task after retrying. No source data changed. Check that Tasks is available, then ask for a new check.";
export const SCHEDULED_READ_IMMEDIATE_FAILURE =
  "I couldn't read that task. No source data changed. Check that Tasks is available, then ask for a new check.";
export const SCHEDULED_REPORT_FAILED =
  "I read the task, but couldn't produce a reliable report. No source data changed. Check your AI settings, then ask for a new check.";
export const SCHEDULED_REPORT_UNAVAILABLE =
  "I couldn't produce the task report because a configured JSON model is unavailable. Check your AI settings, then ask for a new check.";
export const SCHEDULED_REPORT_TIMEOUT =
  "The model took too long to prepare the task report. No source data changed. Ask for a new check.";
export const SCHEDULED_SOURCE_CHANGED =
  "The task changed while I was preparing its report, so I discarded the outdated result. Ask for a new check.";
