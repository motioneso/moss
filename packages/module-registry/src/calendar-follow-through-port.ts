// Calendar follow-through port, intents-only edition (R2.3-T06).
//
// Composition emits typed effects and performs no provider call and no
// day-plan write: task creation still resolves through the Tasks port inside
// the generation transaction, while each block_time signal yields an intent
// the generation plan step turns into a plan block. Moved out of index.ts so
// that file does not grow past its limit.
import { TasksRepository } from "@moss/tasks";
import type { CalendarAutoIntent, ComposeDeps } from "@moss/briefings";

import { calendarFollowThroughSourceRef } from "@moss/calendar";

export function buildCalendarFollowThroughPort(
  deps: {
    readonly tasksRepository?: Pick<TasksRepository, "create">;
  } = {}
): NonNullable<ComposeDeps["calendarFollowThrough"]> {
  const tasksRepository = deps.tasksRepository ?? new TasksRepository();

  return {
    async executeAutoActions({ scopedDb, targetRef, signal }) {
      const intents: CalendarAutoIntent[] = [];
      const sourceRef = calendarFollowThroughSourceRef(targetRef);
      let taskId: string | undefined;

      if (signal.suggestedActions.includes("create_task")) {
        const task = await tasksRepository.create(scopedDb, {
          title: signal.summary,
          status: "todo",
          source: "calendar",
          sourceRef,
          externalKey: sourceRef
        });
        taskId = task.id;
        intents.push({ kind: "create_task", targetRef, title: signal.summary });
      }

      if (signal.suggestedActions.includes("block_time")) {
        const window = calendarFollowThroughWindow(signal);
        if (window) {
          intents.push({
            kind: "block_time",
            targetRef,
            title: signal.summary,
            window: {
              start: window.start.toISOString(),
              end: window.end.toISOString(),
              durationMinutes: window.durationMinutes
            }
          });
        }
      }

      return { targetRef, ...(taskId ? { taskId } : {}), intents };
    }
  };
}

// Window source for a block_time intent: prep signals take the hour before
// the meeting, other signals are capped to the meeting window itself.
export function calendarFollowThroughWindow(signal: {
  readonly type?: string;
  readonly summary: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}): { start: Date; end: Date; durationMinutes: number; title: string } | null {
  const start = signal.startsAt ? new Date(signal.startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = signal.endsAt ? new Date(signal.endsAt) : null;
  if (signal.type === "prep_needed") {
    const prepEnd = start;
    const prepStart = new Date(prepEnd.getTime() - 60 * 60_000);
    return { start: prepStart, end: prepEnd, durationMinutes: 60, title: "Prep time" };
  }
  if (!end || Number.isNaN(end.getTime()) || end <= start) return null;
  const durationMinutes = Math.min(
    120,
    Math.max(15, Math.floor((end.getTime() - start.getTime()) / 60_000))
  );
  return { start, end, durationMinutes, title: "Focus time" };
}
