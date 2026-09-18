import {
  type CalendarEventDto,
  type DayPlanBlockKind,
  type DayPlanDto,
  type DayPlanTaskSummary,
  type LocaleSettingsDto,
  localDay
} from "@moss/shared";

import { byStart, isToday } from "./today-labels.js";

export type DayItemState =
  | "committed"
  | "proposed"
  | "pending"
  | "unscheduled"
  | "completed"
  | "event";

export const DAY_ITEM_STATE_LABELS: Record<DayItemState, string> = {
  committed: "On the calendar",
  proposed: "Proposed, not on the calendar yet",
  pending: "Change pending",
  unscheduled: "Unscheduled",
  completed: "Done",
  event: ""
};

const KIND_LABELS: Partial<Record<DayPlanBlockKind | "travel" | "task", string>> = {
  prep: "Preparation",
  travel: "Travel"
};

export interface DayItem {
  readonly key: string;
  readonly kind: DayPlanBlockKind | "travel" | "task" | "event";
  readonly kindLabel: string | null;
  readonly state: DayItemState;
  readonly label: string;
  readonly title: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly durationMinutes: number | null;
  readonly taskId: string | null;
  readonly unavailable: boolean;
  readonly eventId: string | null;
  readonly location: string | null;
}

export interface BuildDayItemsInput {
  readonly plan: DayPlanDto | null;
  readonly tasks: readonly DayPlanTaskSummary[];
  readonly unavailableTaskIds: readonly string[];
  readonly events: readonly CalendarEventDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly targetDayKey?: string;
}

function stateForBlock(input: {
  readonly summary: DayPlanTaskSummary | undefined;
  readonly startsAt: string | null;
  readonly hasPendingChange: boolean;
  readonly hasTaskId: boolean;
  readonly planHasEveningIntent: boolean;
  readonly planHasCommittedBlock: boolean;
}): DayItemState {
  if (input.summary?.status === "done") return "completed";
  if (input.hasPendingChange) return "pending";
  if (input.startsAt !== null) return "committed";
  if (input.hasTaskId && (input.planHasEveningIntent || input.planHasCommittedBlock))
    return "proposed";
  return "unscheduled";
}

export function buildDayItems(input: BuildDayItemsInput): DayItem[] {
  const events = input.events
    .filter((event) =>
      input.targetDayKey !== undefined
        ? localDay(event.startsAt, input.locale.timezone) === input.targetDayKey
        : isToday(event, input.locale.timezone)
    )
    .sort(byStart)
    .map(
      (event): DayItem => ({
        key: `event:${event.id}`,
        kind: "event",
        kindLabel: null,
        state: "event",
        label: DAY_ITEM_STATE_LABELS.event,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        durationMinutes: Math.max(
          0,
          Math.round((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60000)
        ),
        taskId: null,
        unavailable: false,
        eventId: event.id,
        location: event.location
      })
    );

  if (input.plan === null) return events;

  const plan = input.plan;
  const summaries = new Map(input.tasks.map((task) => [task.id, task]));
  const unavailable = new Set(input.unavailableTaskIds);
  const planHasEveningIntent = plan.eveningIntent !== null;
  const planHasCommittedBlock = plan.blocks.some(
    (block) => block.pendingChange === null && block.actualPlacement?.startsAt != null
  );

  const blocks = [...plan.blocks]
    .sort((a, b) => a.position - b.position)
    .map((block, index): { readonly item: DayItem; readonly order: number } => {
      const summary = block.taskId !== null ? summaries.get(block.taskId) : undefined;
      const startsAt =
        block.pendingChange !== null && block.pendingChange.kind !== "remove"
          ? block.pendingChange.startsAt
          : (block.actualPlacement?.startsAt ?? null);
      const durationMinutes =
        block.pendingChange !== null && block.pendingChange.kind !== "remove"
          ? block.pendingChange.durationMinutes
          : (block.actualPlacement?.durationMinutes ?? null);
      const state = stateForBlock({
        summary,
        startsAt,
        hasPendingChange: block.pendingChange !== null,
        hasTaskId: block.taskId !== null,
        planHasEveningIntent,
        planHasCommittedBlock
      });
      const title = summary !== undefined ? summary.title : (block.title ?? "Untitled block");
      return {
        order: index,
        item: {
          key: `block:${block.id}`,
          kind: block.kind,
          kindLabel: KIND_LABELS[block.kind] ?? null,
          state,
          label: DAY_ITEM_STATE_LABELS[state],
          title,
          startsAt,
          endsAt: null,
          durationMinutes,
          taskId: block.taskId,
          unavailable: block.taskId !== null && unavailable.has(block.taskId),
          eventId: null,
          location: null
        }
      };
    });

  const withStart = blocks.filter(({ item }) => item.startsAt !== null);
  const withoutStart = blocks.filter(({ item }) => item.startsAt === null);
  withStart.sort((a, b) => {
    const diff = Date.parse(a.item.startsAt!) - Date.parse(b.item.startsAt!);
    return diff !== 0 ? diff : a.order - b.order;
  });

  const timed: Array<{ readonly at: number; readonly order: number; readonly item: DayItem }> = [
    ...withStart.map(({ item, order }) => ({
      at: Date.parse(item.startsAt!),
      order,
      item
    })),
    ...events.map((item, eventIndex) => ({
      at: Date.parse(item.startsAt!),
      order: blocks.length + eventIndex,
      item
    }))
  ].sort((a, b) => (a.at !== b.at ? a.at - b.at : a.order - b.order));

  return [...timed.map((entry) => entry.item), ...withoutStart.map(({ item }) => item)];
}
