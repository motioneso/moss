// Row marks shared with the legacy screen: drift pill, effort label, assistant source.
import { localDay } from "./local-date.mjs";

const effortLabels = { quick: "Small", medium: "Medium", large: "Large" };

export const effortLabel = (effort) => effortLabels[effort] ?? null;

// A task the assistant made carries a source other than the user's own.
export function isAssistantSource(source) {
  const value = String(source ?? "").toLowerCase();
  return value !== "" && value !== "user" && value !== "manual";
}

// Day buckets use the account zone. Done tasks never drift.
export function driftMark(task, now = new Date(), timeZone = "UTC") {
  if (!task.dueAt || task.status === "done") return null;
  const today = localDay(now, timeZone);
  const due = localDay(task.dueAt, timeZone);
  if (due < today) return { kind: "overdue", label: "Overdue" };
  const days = (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= 2 ? { kind: "atrisk", label: "At risk" } : null;
}

export function assistantTrackedCount(tasks) {
  return tasks.filter((task) => task.status !== "done" && isAssistantSource(task.source)).length;
}

export function trackingNote(count, assistantName = "Moss") {
  if (!count) return "";
  return `${assistantName} is tracking ${count} ${count === 1 ? "task" : "tasks"} it created for you. Each is marked by source.`;
}
