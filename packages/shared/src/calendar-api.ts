import { errorResponseSchema, nullableStringSchema } from "./schema-fragments.js";

export interface CalendarEventDto {
  readonly id: string;
  readonly connectorAccountId: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string | null;
  readonly summary: string | null;
  readonly bodyExcerpt: string | null;
  readonly externalId: string;
  readonly isMossBlock: boolean;
  readonly allDay: boolean;
  readonly attendeeCount: number;
  readonly status: string | null;
  readonly readOnly?: boolean;
  readonly unconfirmed?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListCalendarEventsResponse {
  readonly events: readonly CalendarEventDto[];
}

export interface GetCalendarEventResponse {
  readonly event: CalendarEventDto;
}

const calendarEventParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" }
  }
} as const;

export const calendarEventDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "connectorAccountId",
    "ownerUserId",
    "title",
    "startsAt",
    "endsAt",
    "location",
    "summary",
    "bodyExcerpt",
    "externalId",
    "isMossBlock",
    "allDay",
    "attendeeCount",
    "status",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    connectorAccountId: { type: "string" },
    ownerUserId: { type: "string" },
    title: { type: "string" },
    startsAt: { type: "string" },
    endsAt: { type: "string" },
    location: nullableStringSchema,
    summary: nullableStringSchema,
    bodyExcerpt: nullableStringSchema,
    externalId: { type: "string" },
    isMossBlock: { type: "boolean" },
    allDay: { type: "boolean" },
    attendeeCount: { type: "number" },
    status: nullableStringSchema,
    readOnly: { type: "boolean" },
    unconfirmed: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
} as const;

export const listCalendarEventsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: calendarEventDtoSchema
    }
  }
} as const;

export const getCalendarEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event"],
  properties: {
    event: calendarEventDtoSchema
  }
} as const;

export const listCalendarEventsRouteSchema = {
  response: {
    200: listCalendarEventsResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const getCalendarEventRouteSchema = {
  params: calendarEventParamsSchema,
  response: {
    200: getCalendarEventResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export interface DeleteCalendarEventResponse {
  readonly deleted: boolean;
  readonly googleDeleted: "deleted" | "already-gone" | "skipped-no-scope" | "skipped-error";
  readonly cacheMirror: "queued" | "deleted" | "skipped-rls" | "skipped-error" | "not-cached";
  readonly deletedTitle?: string;
  readonly message?: string;
}

export const deleteCalendarEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deleted", "googleDeleted", "cacheMirror"],
  properties: {
    deleted: { type: "boolean" },
    googleDeleted: {
      type: "string",
      enum: ["deleted", "already-gone", "skipped-no-scope", "skipped-error"]
    },
    cacheMirror: {
      type: "string",
      enum: ["queued", "deleted", "skipped-rls", "skipped-error", "not-cached"]
    },
    deletedTitle: { type: "string" },
    message: { type: "string" }
  }
} as const;
