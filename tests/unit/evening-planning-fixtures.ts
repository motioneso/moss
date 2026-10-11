import type { CalendarEventDto, DayPlanBlockDto, DayPlanDto, TaskDto } from "@moss/shared";

export const TZ = "America/Los_Angeles";
export const TODAY = "2026-09-10";
export const TMO = "2026-09-11";

export function taskDto(id: string, title: string, overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id,
    title,
    status: "todo",
    dueAt: null,
    effort: null,
    ...overrides
  } as unknown as TaskDto;
}

export function block(id: string, overrides: Partial<DayPlanBlockDto> = {}): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId: null,
    title: null,
    position: 0,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}

export function taskDtos(): TaskDto[] {
  return [
    taskDto("t1", "Write the launch brief", { dueAt: `${TMO}T12:00:00.000Z` }),
    taskDto("t2", "Call the vendor", { dueAt: `${TODAY}T12:00:00.000Z` }),
    taskDto("t3", "File the report"),
    taskDto("t4", "Water the plants", { status: "done" }),
    taskDto("t-cal", "Dentist", { effort: "medium" })
  ];
}

export function todayPlan(): DayPlanDto {
  return {
    id: "plan-today",
    localDay: TODAY,
    timeZone: TZ,
    revision: 2,
    sourceRunId: null,
    eveningIntent: null,
    blocks: [
      block("bt1", { taskId: "t1", position: 0 }),
      block("bt2", { taskId: "t2", position: 1 })
    ]
  };
}

export function tomorrowPlan(): DayPlanDto {
  return {
    id: "plan-tmo",
    localDay: TMO,
    timeZone: TZ,
    revision: 4,
    sourceRunId: null,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    },
    blocks: [
      block("b-cal", {
        taskId: "t-cal",
        position: 0,
        actualPlacement: {
          startsAt: `${TMO}T14:00:00.000Z`,
          durationMinutes: 60,
          calendarEventRef: "ev-0"
        }
      }),
      block("b-p1", {
        taskId: "t1",
        position: 1,
        pendingChange: { kind: "add", startsAt: `${TMO}T16:00:00.000Z`, durationMinutes: 30 }
      }),
      block("b-p2", {
        taskId: "t2",
        position: 2,
        pendingChange: { kind: "add", startsAt: `${TMO}T18:00:00.000Z`, durationMinutes: 30 }
      })
    ]
  };
}

export function events(): CalendarEventDto[] {
  return [
    {
      id: "ev-morn",
      title: "Standup",
      startsAt: `${TMO}T16:00:00.000Z`,
      endsAt: `${TMO}T17:00:00.000Z`,
      allDay: false,
      isMossBlock: false,
      attendeeCount: 0
    } as unknown as CalendarEventDto
  ];
}
