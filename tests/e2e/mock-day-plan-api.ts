import type { Page, Route } from "@playwright/test";
import type {
  ApplyExecutionItemReport,
  ApplyExecutionReport,
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanCalendarAvailability,
  DayPlanChangeSetEntry,
  DayPlanDto,
  DayPlanPendingChange,
  DayPlanTaskSummary,
  PreviewDayPlanResponse
} from "@moss/shared";

export interface MockDayPlanApiState {
  plan: DayPlanDto;
  /** Tomorrow's plan when the test seeds one; absent means the GET 404s. */
  tomorrowPlan?: DayPlanDto;
  tasks: DayPlanTaskSummary[];
  unavailableTaskIds?: string[];
  fixedEvents?: CalendarEventDto[];
  calendarAvailability?: DayPlanCalendarAvailability;
  /** When true the confirm route answers 409 once, then executes. */
  confirmStaleOnce?: boolean;
}

interface PendingApproval {
  approvalId: string;
  operationId: string;
  changes: DayPlanChangeSetEntry[];
}

function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

function overlaps(aStart: string, aMinutes: number, bStart: string, bEnd: string): boolean {
  const start = Date.parse(aStart);
  const end = start + aMinutes * 60_000;
  return start < Date.parse(bEnd) && Date.parse(bStart) < end;
}

export async function registerMockDayPlanRoutes(
  page: Page,
  state: MockDayPlanApiState
): Promise<void> {
  let approval: PendingApproval | null = null;
  let operation = 0;
  const confirmUsed = { stale: false };

  await page.route("**/api/calendar/briefing-settings", (route) =>
    fulfillJson(route, 200, {
      settings: {
        lookaheadDays: 1,
        prepTaskMode: "suggest",
        timeBlockMode: "suggest",
        suggestTasks: true,
        createTasks: false,
        suggestTimeBlocks: true,
        blockTime: false
      }
    })
  );

  const planForId = (url: string): DayPlanDto | null => {
    const id = url.split("/api/calendar/day-plans/")[1]?.split("/")[0] ?? null;
    for (const plan of [state.plan, state.tomorrowPlan]) {
      if (plan && plan.id === id) return plan;
    }
    return null;
  };
  const commitPlan = (plan: DayPlanDto): void => {
    if (state.tomorrowPlan && state.tomorrowPlan.id === plan.id) state.tomorrowPlan = plan;
    else state.plan = plan;
  };

  await page.route("**/api/calendar/day-plan*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const date = new URL(route.request().url()).searchParams.get("date");
    const plan =
      state.tomorrowPlan && state.tomorrowPlan.localDay === date
        ? state.tomorrowPlan
        : state.plan.localDay === date
          ? state.plan
          : null;
    if (!plan) return fulfillJson(route, 404, { error: "day plan is not available" });
    return fulfillJson(route, 200, {
      plan,
      tasks: state.tasks,
      unavailableTaskIds: state.unavailableTaskIds ?? [],
      sourceRun: null,
      sourceRunUnavailable: false
    });
  });

  await page.route("**/api/calendar/day-plans", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { date: string; timeZone: string };
    const existing = [state.plan, state.tomorrowPlan].find((plan) => plan?.localDay === body.date);
    if (existing) return fulfillJson(route, 200, { plan: existing });
    const created: DayPlanDto = {
      id: `plan-${body.date}`,
      localDay: body.date,
      timeZone: body.timeZone,
      revision: 1,
      sourceRunId: null,
      blocks: [],
      eveningIntent: null
    };
    state.tomorrowPlan = created;
    return fulfillJson(route, 200, { plan: created });
  });

  await page.route("**/api/calendar/day-plans/*/draft", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      eveningIntent?: DayPlanDto["eveningIntent"];
      blocks?: {
        id?: string;
        kind: DayPlanDto["blocks"][number]["kind"];
        taskId: string | null;
        title: string | null;
        pendingChange?: DayPlanPendingChange | null;
      }[];
    };
    const plan = planForId(route.request().url());
    if (!plan) return fulfillJson(route, 404, { error: "day plan is not available" });
    if (body.expectedRevision !== plan.revision) {
      return fulfillJson(route, 409, { error: "day plan changed since it was read" });
    }
    // Like the server, a draft replaces the whole block list: rows absent
    // from the submission are deleted (a placed row deleted this way is a
    // 400). Rows without an id are inserted, like first-time proposals.
    const seen = new Set<string>();
    let inserted = 0;
    for (const row of body.blocks ?? []) {
      const target =
        row.id === undefined ? undefined : plan.blocks.find((entry) => entry.id === row.id);
      if (target) {
        seen.add(target.id);
        target.pendingChange = row.pendingChange ?? null;
        continue;
      }
      if (row.id === undefined) {
        inserted += 1;
        const id = `mock-new-${inserted}`;
        seen.add(id);
        plan.blocks.push({
          id,
          kind: row.kind,
          taskId: row.taskId,
          title: row.title,
          position: plan.blocks.length,
          actualPlacement: null,
          pendingChange: row.pendingChange ?? null
        });
      }
    }
    for (const entry of plan.blocks) {
      if (!seen.has(entry.id) && entry.actualPlacement) {
        return fulfillJson(route, 400, { error: "recorded placement requires a pending removal" });
      }
    }
    plan.blocks = plan.blocks.filter((entry) => seen.has(entry.id));
    if (body.eveningIntent !== undefined) {
      plan.eveningIntent = {
        ...((plan.eveningIntent as object) ?? {}),
        ...(body.eveningIntent as object)
      } as DayPlanDto["eveningIntent"];
    }
    commitPlan({ ...plan, revision: plan.revision + 1 });
    const saved = planForId(route.request().url());
    return fulfillJson(route, 200, { plan: saved });
  });

  await page.route("**/api/calendar/day-plans/*/preview", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      selectedChangeBlockIds: string[];
    };
    const previewPlan = planForId(route.request().url());
    if (!previewPlan) return fulfillJson(route, 404, { error: "day plan is not available" });
    if (body.expectedRevision !== previewPlan.revision) {
      return fulfillJson(route, 409, { error: "day plan changed since it was read" });
    }
    const availability = state.calendarAvailability ?? "available";
    const response: PreviewDayPlanResponse = {
      revision: previewPlan.revision,
      calendarAvailability: availability,
      calendarAsOf: null,
      blocks: [],
      eligibleBlockIds: [],
      conflicts: []
    };
    for (const blockId of body.selectedChangeBlockIds) {
      const block = previewPlan.blocks.find((entry) => entry.id === blockId);
      const pending = block?.pendingChange;
      if (!block || !pending || pending.kind === "remove") continue;
      const eligible = availability !== "unavailable";
      response.blocks.push({
        blockId,
        taskId: block.taskId,
        changeKind: pending.kind,
        before:
          block.actualPlacement?.startsAt && block.actualPlacement.durationMinutes !== null
            ? {
                startsAt: block.actualPlacement.startsAt,
                durationMinutes: block.actualPlacement.durationMinutes
              }
            : null,
        after: { startsAt: pending.startsAt, durationMinutes: pending.durationMinutes },
        eligible,
        ineligibleReason: null,
        deadlineRisk: false
      });
      if (eligible) response.eligibleBlockIds.push(blockId);
      // Like the server, eligible follows task facts only; calendar clashes
      // stay in conflicts and never shrink the eligible list here.
      for (const event of state.fixedEvents ?? []) {
        if (overlaps(pending.startsAt, pending.durationMinutes, event.startsAt, event.endsAt)) {
          response.conflicts.push({
            blockId,
            kind: "calendar_busy",
            withBlockId: null,
            detail: `Overlaps ${event.title}`,
            calendarEvent: {
              eventKey: event.id,
              title: event.title,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              accountLabel: "Calendar"
            }
          });
        }
      }
    }
    return fulfillJson(route, 200, response);
  });

  function executeReport(plan: DayPlanDto, ids: string[]): ApplyExecutionReport {
    operation += 1;
    const items: ApplyExecutionItemReport[] = ids.map((blockId, index) => {
      const block = plan.blocks.find((entry) => entry.id === blockId);
      const pending = block?.pendingChange;
      if (block && pending && pending.kind === "remove") {
        block.actualPlacement = null;
        block.pendingChange = null;
      } else if (block && pending && pending.kind !== "remove") {
        block.actualPlacement = {
          startsAt: pending.startsAt,
          durationMinutes: pending.durationMinutes,
          calendarEventRef: `mock-ev-${operation}-${index}`
        };
        block.pendingChange = null;
      }
      const timing = pending && pending.kind !== "remove" ? pending : null;
      return {
        itemId: `mock-item-${operation}-${index}`,
        blockId,
        outcome: "applied" as const,
        result: timing
          ? {
              status: "applied" as const,
              providerEventId: `mock-ev-${operation}-${index}`,
              startsAt: timing.startsAt,
              durationMinutes: timing.durationMinutes,
              calendarMirror: "written" as const,
              blockMirror: "mirrored" as const
            }
          : {
              status: "applied" as const,
              removed: true as const,
              providerEventId: `mock-ev-${operation}-${index}`,
              startsAt: null,
              durationMinutes: null,
              calendarMirror: "written" as const,
              blockMirror: "mirrored" as const
            }
      };
    });
    return {
      operationId: `mock-op-${operation}`,
      planId: plan.id,
      status: "completed",
      items
    };
  }

  await page.route("**/api/calendar/day-plans/*/apply", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      idempotencyKey: string;
      selectedBlockIds?: string[];
    };
    const plan = planForId(route.request().url());
    if (!plan) return fulfillJson(route, 404, { error: "day plan is not available" });
    if (body.expectedRevision !== plan.revision) {
      return fulfillJson(route, 409, { error: "day plan changed since it was read" });
    }
    const selected = body.selectedBlockIds ?? [];
    // Like the server, one clash denies the whole batch with zero writes.
    for (const blockId of selected) {
      const pending = plan.blocks.find((entry) => entry.id === blockId)?.pendingChange;
      if (!pending || pending.kind === "remove") continue;
      for (const event of state.fixedEvents ?? []) {
        if (overlaps(pending.startsAt, pending.durationMinutes, event.startsAt, event.endsAt)) {
          operation += 1;
          return fulfillJson(route, 200, {
            operationId: `mock-op-${operation}`,
            planId: plan.id,
            status: "denied",
            denialReason: `conflict: reserved additions overlap protected time (${blockId}:calendar_busy)`,
            items: selected.map((id) => ({
              itemId: null,
              blockId: id,
              outcome: "failed",
              result: { status: "failed", reason: "conflict" }
            }))
          });
        }
      }
    }
    const moves = selected.filter((blockId) => {
      const pending = plan.blocks.find((entry) => entry.id === blockId)?.pendingChange;
      return pending?.kind === "move" || pending?.kind === "remove";
    });
    if (moves.length > 0) {
      operation += 1;
      approval = {
        approvalId: `mock-approval-${operation}`,
        operationId: `mock-op-${operation}`,
        changes: moves.map((blockId) => {
          const block = plan.blocks.find((entry) => entry.id === blockId)!;
          const pending = block.pendingChange!;
          return {
            blockId,
            kind: pending.kind as "move" | "remove",
            calendarEventRef: block.actualPlacement?.calendarEventRef ?? null,
            startsAt: pending.kind === "remove" ? null : pending.startsAt,
            durationMinutes: pending.kind === "remove" ? null : pending.durationMinutes
          };
        })
      };
      return fulfillJson(route, 202, {
        status: "confirmation-required",
        operationId: approval.operationId,
        approvalId: approval.approvalId,
        changes: approval.changes
      });
    }
    return fulfillJson(route, 200, executeReport(plan, selected));
  });

  await page.route("**/api/calendar/day-plans/*/operations/*/confirm", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { approvalId: string };
    if (state.confirmStaleOnce && !confirmUsed.stale) {
      confirmUsed.stale = true;
      return fulfillJson(route, 409, { error: "approval is no longer pending" });
    }
    if (!approval || body.approvalId !== approval.approvalId) {
      return fulfillJson(route, 409, { error: "approval is no longer pending" });
    }
    const ids = approval.changes.map((entry) => entry.blockId);
    approval = null;
    const plan = planForId(route.request().url()) ?? state.plan;
    return fulfillJson(route, 200, executeReport(plan, ids));
  });

  await page.route("**/api/calendar/day-plans/*/operations/*/retry", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { itemIds: string[] };
    void body;
    const plan = planForId(route.request().url()) ?? state.plan;
    return fulfillJson(route, 200, executeReport(plan, []));
  });
}

export function mockDayPlanBlock(
  id: string,
  taskId: string | null,
  position: number,
  overrides: Partial<DayPlanBlockDto> = {}
): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId,
    title: null,
    position,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}

export function mockDayPlanTask(
  id: string,
  title: string,
  dueAt: string | null = null
): DayPlanTaskSummary {
  return { id, title, status: "todo", dueAt, doAt: null, effort: null };
}
