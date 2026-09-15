import type { BriefingPlanBlockV1, BriefingPlanContextV1 } from "@moss/shared";

import { capLines, emptySection, type Section } from "./compose-shared.js";
import { planOvernightChanges } from "./plan-reconcile.js";
import { sanitizeExternal } from "./trust-boundary.js";

export const DAY_PLAN_SECTION_KEY = "day_plan";
export const DAY_PLAN_SECTION_LABEL = "SAVED DAY PLAN";
const NO_BLOCKS_LINE = "No task blocks were planned for today.";

function taskTitle(
  taskItems: readonly Record<string, unknown>[] | undefined,
  taskId: string | null
): string | null {
  if (!taskId) return null;
  for (const item of taskItems ?? []) {
    if (item["id"] === taskId && typeof item["title"] === "string" && item["title"] !== "") {
      return item["title"];
    }
  }
  return null;
}

function committedWindow(block: BriefingPlanBlockV1): string {
  const placement = block.actualPlacement;
  if (!placement || !placement.startsAt || !placement.durationMinutes) return "committed";
  const end = new Date(new Date(placement.startsAt).getTime() + placement.durationMinutes * 60_000);
  return Number.isNaN(end.getTime())
    ? "committed"
    : `committed ${placement.startsAt}-${end.toISOString()}`;
}

function blockLine(block: BriefingPlanBlockV1): string {
  const name = `${block.kind} "${block.title ?? block.id}" (position ${block.position})`;
  if (block.pendingChange) return `${name}: pending change: ${block.pendingChange}`;
  if (!block.actualPlacement) return `${name}: proposed, not on the calendar yet`;
  return `${name}: ${committedWindow(block)}`;
}

/**
 * Render the saved day plan as one untrusted data section. Every free string
 * passes through sanitizeExternal; the list passes through capLines. A null
 * context yields an empty section, which renders as "(none today)".
 */
export function planSection(
  plan: BriefingPlanContextV1 | null | undefined,
  taskItems: readonly Record<string, unknown>[] | undefined,
  calendarItems?: readonly Record<string, unknown>[] | undefined
): Section {
  if (!plan) return emptySection(DAY_PLAN_SECTION_KEY, DAY_PLAN_SECTION_LABEL);
  const lines: string[] = [];
  const intent = plan.eveningIntent;
  if (intent) {
    for (const taskId of intent.priorityTaskIds) {
      lines.push(`Priority (saved last evening): ${taskTitle(taskItems, taskId) ?? taskId}`);
    }
    if (intent.capacity) lines.push(`Capacity (saved last evening): ${intent.capacity}`);
    if (intent.notes) lines.push(`Note (saved last evening): ${intent.notes}`);
    for (const correction of intent.corrections) {
      lines.push(`Correction (${correction.source}): ${correction.note}`);
    }
    for (const commitment of intent.commitments) {
      lines.push(`Commitment: ${commitment.taskId} ${commitment.decision}`);
    }
  }
  for (const block of plan.blocks) {
    lines.push(blockLine(block));
  }
  for (const change of planOvernightChanges(plan, calendarItems, taskItems)) {
    lines.push(change);
  }
  if (intent && plan.blocks.length === 0) {
    lines.push(NO_BLOCKS_LINE);
  }
  const sanitized = lines.map((line) => sanitizeExternal(line)).filter((line) => line !== "");
  const capped = capLines(sanitized);
  return {
    key: DAY_PLAN_SECTION_KEY,
    label: DAY_PLAN_SECTION_LABEL,
    lines: capped.lines,
    count: sanitized.length
  };
}
