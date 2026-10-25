import type { ModuleVisualTemplate } from "@moss/module-sdk/visual-template";
import { isValidTimeZone, localDay, tryCopyVisualSnapshot, VISUAL_LIMITS } from "@moss/shared";
import {
  REMINDER_SUMMARY_CONTEXT_STATES,
  REMINDER_SUMMARY_LIMIT,
  REMINDER_SUMMARY_SCOPES,
  REMINDER_SUMMARY_STATES,
  type ReminderSummary,
  type ReminderSummaryItem,
  type ReminderSummaryScope,
  type ReminderSummaryState
} from "./types.js";

export const reminderScopeLabels: Record<ReminderSummaryScope, string> = {
  upcoming: "Reminders still waiting to be delivered (scheduled or paused)",
  delivered: "Reminders already delivered",
  ended: "Reminders that ended without delivery (cancelled, expired or failed)",
  all: "Reminders in every saved state"
};
const stateLabels: Record<ReminderSummaryState, string> = {
  queued: "Scheduled",
  paused: "Paused",
  delivered: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired"
};
const SCOPE_STATES: Record<ReminderSummaryScope, readonly ReminderSummaryState[]> = {
  upcoming: ["queued", "paused"],
  delivered: ["delivered"],
  ended: ["cancelled", "expired", "failed"],
  all: REMINDER_SUMMARY_STATES
};

export function reminderSummaryCoverage(v: ReminderSummary): string {
  return `${reminderScopeLabels[v.scope]}. ${v.truncated ? `Partial: first ${v.items.length} matching reminders by due time; more exist.` : `${v.items.length} matching saved reminders in this scope.`} Only your own reminders are included. Repeating reminders show their saved next time only; later repeats are not generated. Dismissing a delivered reminder from chat context is not cancelling it. Nothing was changed by this read.`;
}
const text = (v: unknown, max = 500): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const instant = (v: unknown): v is string =>
  text(v, 30) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v);
const ITEM_KEYS = [
  "id",
  "text",
  "state",
  "contextState",
  "timing",
  "dueAt",
  "dueLocalDay",
  "deadlineAt",
  "repeat",
  "destinationTitle",
  "deliveredAt",
  "late",
  "createdAt"
];

function validRepeat(r: unknown): boolean {
  if (r === null) return true;
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  if (o.kind === "daily" || o.kind === "weekly") return Object.keys(o).length === 1;
  return (
    o.kind === "interval" &&
    Object.keys(o).length === 2 &&
    typeof o.seconds === "number" &&
    Number.isInteger(o.seconds) &&
    o.seconds >= 60 &&
    o.seconds < 86_400
  );
}
function validItem(item: unknown, timeZone: string): item is ReminderSummaryItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const i = item as Record<string, unknown>;
  const keys = Object.keys(i);
  if (keys.length !== ITEM_KEYS.length || !ITEM_KEYS.every((k) => keys.includes(k))) return false;
  const delivered = i.state === "delivered";
  return (
    uuid(i.id) &&
    text(i.text) &&
    REMINDER_SUMMARY_STATES.includes(i.state as ReminderSummaryState) &&
    REMINDER_SUMMARY_CONTEXT_STATES.includes(i.contextState as never) &&
    (i.timing === "relative" || i.timing === "local_clock") &&
    instant(i.dueAt) &&
    i.dueLocalDay === localDay(i.dueAt, timeZone) &&
    (i.deadlineAt === null || instant(i.deadlineAt)) &&
    validRepeat(i.repeat) &&
    (i.destinationTitle === null || text(i.destinationTitle, 200)) &&
    (delivered ? instant(i.deliveredAt) && typeof i.late === "boolean" : i.deliveredAt === null) &&
    (delivered || i.late === null) &&
    instant(i.createdAt)
  );
}
export function readReminderSummarySnapshot(value: unknown): ReminderSummary | null {
  const copied = tryCopyVisualSnapshot(value);
  if (!copied.ok) return null;
  const s = copied.snapshot,
    v = s.fields;
  if (
    s.kind !== "reminders.summary" ||
    s.origin !== "source" ||
    s.source.id !== "chat" ||
    s.source.label !== "Reminders" ||
    Object.keys(v).length !== 6 ||
    !REMINDER_SUMMARY_SCOPES.includes(v.scope as ReminderSummaryScope) ||
    !text(v.timeZone, 100) ||
    !isValidTimeZone(v.timeZone) ||
    !instant(v.retrievedAt) ||
    s.retrievedAt !== v.retrievedAt ||
    v.localDate !== localDay(v.retrievedAt, v.timeZone) ||
    typeof v.truncated !== "boolean" ||
    !Array.isArray(v.items) ||
    v.items.length > REMINDER_SUMMARY_LIMIT ||
    (v.truncated && v.items.length === 0)
  )
    return null;
  const ids = new Set<string>();
  for (const item of v.items) {
    if (!validItem(item, v.timeZone) || ids.has(item.id)) return null;
    if (!SCOPE_STATES[v.scope as ReminderSummaryScope].includes(item.state)) return null;
    ids.add(item.id);
  }
  const result = v as unknown as ReminderSummary;
  return s.coverage === reminderSummaryCoverage(result) ? result : null;
}
export function reminderRepeatText(r: ReminderSummaryItem["repeat"]): string {
  if (!r) return "Does not repeat";
  if (r.kind === "interval")
    return r.seconds % 60 === 0
      ? `Repeats every ${r.seconds / 60} minutes`
      : `Repeats every ${r.seconds} seconds`;
  return r.kind === "daily" ? "Repeats daily" : "Repeats weekly";
}
export function reminderSummaryItemText(item: ReminderSummaryItem, timeZone: string): string {
  const parts = [
    stateLabels[item.state],
    `Due ${item.dueAt} (${item.dueLocalDay} ${timeZone})`,
    item.timing === "local_clock" ? "Set for a clock time" : "Set as a delay",
    reminderRepeatText(item.repeat),
    `Destination ${item.destinationTitle ?? "Main chat"}`
  ];
  if (item.deadlineAt) parts.push(`Deadline ${item.deadlineAt}`);
  if (item.deliveredAt)
    parts.push(`Delivered ${item.deliveredAt}${item.late ? " (late)" : " (on time)"}`);
  if (item.contextState === "dismissed") parts.push("Dismissed from chat context");
  else if (item.contextState === "acknowledged") parts.push("Acknowledged in chat context");
  return parts.join(" · ");
}
function formatReminderSummary(v: ReminderSummary): string {
  return `${reminderScopeLabels[v.scope]} · ${v.localDate} · ${v.timeZone}. ${v.items.map((item) => `${item.text} [${item.id}]: ${reminderSummaryItemText(item, v.timeZone)}; created ${item.createdAt}`).join(". ")}${v.items.length ? ". " : ""}Reminders; retrieved ${v.retrievedAt}. ${reminderSummaryCoverage(v)}`;
}
export function formatReminderSummarySnapshot(value: unknown): string {
  const v = readReminderSummarySnapshot(value);
  return v ? formatReminderSummary(v) : "";
}
/** Keeps the same ordered source prefix in both card and complete readable fallback. */
export function boundReminderSummary(summary: ReminderSummary): ReminderSummary {
  let bounded = summary;
  while (
    bounded.items.length > 1 &&
    formatReminderSummary(bounded).length > VISUAL_LIMITS.fallbackTextLength
  ) {
    bounded = { ...bounded, items: bounded.items.slice(0, -1), truncated: true };
  }
  return bounded;
}
export const reminderSummaryTemplate: ModuleVisualTemplate = Object.freeze({
  kind: "reminders.summary",
  snapshotKind: "reminders.summary",
  validate: (v: unknown) => readReminderSummarySnapshot(v) !== null,
  format: formatReminderSummarySnapshot
});
export default [reminderSummaryTemplate];
