/** Draft records and personal notes only; these contracts do not start capture. */
export interface MeetingRecord {
  readonly id: string;
  readonly title: string;
  readonly personalNotes: string;
  readonly notesRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMeetingRecordInput {
  readonly requestKey: string;
  readonly title: string;
}

export interface MeetingRecordCursor {
  readonly id: string;
  readonly createdAt: string;
}

export interface PutMeetingNotesInput {
  readonly meetingId: string;
  readonly requestKey: string;
  readonly expectedRevision: number;
  readonly personalNotes: string;
}

export type PutMeetingNotesResult =
  | { readonly status: "saved"; readonly replayed: boolean; readonly meeting: MeetingRecord }
  | { readonly status: "conflict"; readonly meeting: MeetingRecord }
  | { readonly status: "not-found" };

const uuid = { type: "string", format: "uuid" } as const;
const meetingParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: uuid }
} as const;

export const createMeetingRecordSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["requestKey", "title"],
    properties: {
      requestKey: uuid,
      title: { type: "string", minLength: 1, maxLength: 240 }
    }
  }
} as const;

export const getMeetingRecordSchema = { params: meetingParams } as const;

export const listMeetingRecordsSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      beforeId: uuid,
      beforeCreatedAt: { type: "string", format: "date-time" }
    },
    dependencies: {
      beforeId: ["beforeCreatedAt"],
      beforeCreatedAt: ["beforeId"]
    }
  }
} as const;

export const putMeetingNotesSchema = {
  params: meetingParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["requestKey", "expectedRevision", "personalNotes"],
    properties: {
      requestKey: uuid,
      expectedRevision: { type: "integer", minimum: 0, maximum: 2147483646 },
      personalNotes: { type: "string", maxLength: 64000 }
    }
  }
} as const;
export interface PutMeetingTitleInput {
  readonly meetingId: string;
  readonly title: string;
  readonly expectedTitle: string;
}
export type PutMeetingTitleResult =
  | { readonly status: "saved"; readonly meeting: MeetingRecord }
  | { readonly status: "conflict"; readonly meeting: MeetingRecord }
  | { readonly status: "not-found" };
export const putMeetingTitleSchema = {
  params: meetingParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["title", "expectedTitle"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 240 },
      expectedTitle: { type: "string", minLength: 1, maxLength: 240 }
    }
  }
} as const;
