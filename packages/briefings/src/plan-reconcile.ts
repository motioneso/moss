import type { BriefingPlanBlockV1, BriefingPlanContextV1 } from "@moss/shared";

import { sanitizeExternal } from "./trust-boundary.js";

const OVERNIGHT_LINE_CAP = 8;
const RECOMMENDATION = "review before accepting";

type Item = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function instant(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : time;
}

function minutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nameOf(
  taskItems: readonly Item[] | undefined,
  taskId: string | null,
  fallback: string
): string {
  if (taskId) {
    for (const item of taskItems ?? []) {
      if (item["id"] === taskId && typeof item["title"] === "string" && item["title"] !== "") {
        return item["title"];
      }
    }
  }
  return fallback;
}

/** Proposed window first, placed window otherwise; null when the block has no time. */
function windowOf(block: BriefingPlanBlockV1): { start: number; end: number } | null {
  const pendingStart = instant(block.pendingStartsAt);
  const pendingMinutes = minutes(block.pendingDurationMinutes);
  if (pendingStart !== null && pendingMinutes !== null) {
    return { start: pendingStart, end: pendingStart + pendingMinutes * 60_000 };
  }
  const placement = block.actualPlacement;
  const placedStart = instant(placement?.startsAt);
  const placedMinutes = minutes(placement?.durationMinutes);
  if (placedStart !== null && placedMinutes !== null) {
    return { start: placedStart, end: placedStart + placedMinutes * 60_000 };
  }
  return null;
}

function eventRef(block: BriefingPlanBlockV1): string | null {
  return text(block.actualPlacement?.calendarEventRef);
}

function findEvent(calendarItems: readonly Item[], ref: string): Item | null {
  for (const item of calendarItems) {
    if (item["id"] === ref || item["eventKey"] === ref) return item;
  }
  return null;
}

function overlaps(start: number, end: number, item: Item): boolean {
  if (item["allDay"] === true) return false;
  const itemStart = instant(item["startsAt"]);
  const itemEnd = instant(item["endsAt"]);
  if (itemStart === null || itemEnd === null) return false;
  return start < itemEnd && itemStart < end;
}

/**
 * Bounded overnight-difference lines for a saved plan: a committed block
 * whose calendar event is gone or moved, a timed block overlapping another
 * event, and a priority or committed task finished since the save. Pure and
 * sanitized; proposals without a time cannot overlap-compare and are skipped.
 */
export function planOvernightChanges(
  plan: BriefingPlanContextV1,
  calendarItems: readonly Item[] | undefined,
  taskItems: readonly Item[] | undefined
): string[] {
  const lines: string[] = [];
  const events = [...(calendarItems ?? [])];
  for (const block of plan.blocks) {
    const name = nameOf(taskItems, block.taskId, block.title ?? block.id);
    const ref = eventRef(block);
    if (ref) {
      const event = findEvent(events, ref);
      if (!event) {
        lines.push(`Overnight change: "${name}" lost its calendar event; ${RECOMMENDATION}.`);
        continue;
      }
      const moved = text(event["startsAt"]);
      if (moved && moved !== block.actualPlacement?.startsAt) {
        lines.push(`Overnight change: the event under "${name}" moved; ${RECOMMENDATION}.`);
      }
    }
    const window = windowOf(block);
    if (window) {
      const clash = events.find(
        (item) =>
          item["id"] !== ref && item["eventKey"] !== ref && overlaps(window.start, window.end, item)
      );
      if (clash) {
        lines.push(
          `Overnight change: "${name}" now overlaps "${text(clash["title"]) ?? "an event"}"; ${RECOMMENDATION}.`
        );
      }
    }
  }
  const watched = new Set<string>();
  for (const taskId of plan.eveningIntent?.priorityTaskIds ?? []) watched.add(taskId);
  for (const block of plan.blocks) {
    if (block.actualPlacement && block.taskId) watched.add(block.taskId);
  }
  for (const commitment of plan.eveningIntent?.commitments ?? []) {
    if (commitment.decision === "commit") watched.add(commitment.taskId);
  }
  for (const taskId of watched) {
    const task = (taskItems ?? []).find((item) => item["id"] === taskId);
    const status = text(task?.["status"]);
    if (status === "done" || status === "archived") {
      lines.push(
        `Overnight change: "${nameOf(taskItems, taskId, taskId)}" is ${status}; ${RECOMMENDATION}.`
      );
    }
  }
  return lines
    .map((line) => sanitizeExternal(line))
    .filter((line) => line !== "")
    .slice(0, OVERNIGHT_LINE_CAP);
}
