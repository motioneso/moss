import type { GatewayToolResponse } from "@moss/ai";

export function scheduledReadReport(response: GatewayToolResponse, itemId: string): string | null {
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
    !["todo", "suggested", "done", "archived"].includes(String(status))
  )
    return null;
  const escaped = title.replace(/[\\`*_{}[\]()<>!#|~]/g, "\\$&").replace(/[\r\n]/g, " ");
  const states: Record<string, string> = {
    todo: "to do",
    suggested: "suggested",
    done: "done",
    archived: "archived"
  };
  return `I checked ${escaped}. Its status is ${states[String(status)]}.\n\n[Source: Tasks](/tasks)`;
}

export const SCHEDULED_READ_REFUSED =
  "I couldn't check that task because access is no longer available. Choose a task you own in Tasks, then ask for a new check.";
export const SCHEDULED_READ_FAILED =
  "I couldn't read that task after retrying. No source data changed. Check that Tasks is available, then ask for a new check.";
