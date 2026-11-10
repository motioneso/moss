import { localDay } from "./local-date.mjs";

// Match the legacy screen presets. At risk here is a due-day filter, distinct
// from the drift API's priority and subtask rules.
export function matchesFocus(task, focus, timeZone, now = Date.now()) {
  if (focus === "priorities")
    return (
      task.status === "todo" &&
      task.priority !== null &&
      task.priority >= 4 &&
      task.dueAt !== null &&
      Date.parse(task.dueAt) <= now + 48 * 3600000
    );
  if (focus === "atrisk") {
    if (task.status !== "todo" || !task.dueAt) return false;
    const today = Date.parse(`${localDay(new Date(now), timeZone)}T00:00:00Z`);
    const due = Date.parse(`${localDay(task.dueAt, timeZone)}T00:00:00Z`);
    return (due - today) / 86400000 <= 2;
  }
  return (
    focus === "donetoday" &&
    task.status === "done" &&
    !!task.completedAt &&
    localDay(task.completedAt, timeZone) === localDay(new Date(now), timeZone)
  );
}

const FOCUS_VALUES = ["priorities", "atrisk", "donetoday"];

// The shell opens the screen with ?focus=<preset> for Today and chat links.
// Anything else is ignored.
export function launchFocus(search) {
  const value = new URLSearchParams(search).get("focus");
  return FOCUS_VALUES.includes(value) ? value : null;
}
