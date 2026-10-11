import type { MeetingRecordCursor } from "./meeting-record-api.js";
import type { MeetingExportReceipt } from "./meeting-export-api.js";

export type MeetingHistoryFilter =
  | "all"
  | "transcript"
  | "needs-review"
  | "exported"
  | "notes-only";
export interface SearchMeetingHistoryInput {
  readonly query?: string;
  readonly filter?: MeetingHistoryFilter;
  readonly limit?: number;
  readonly before?: MeetingRecordCursor;
}
export interface MeetingHistoryPage {
  readonly meetings: readonly MeetingHistoryItem[];
  readonly nextCursor: MeetingRecordCursor | null;
}
/** Meeting-owned receipts only. No native capture, current Task, or filesystem verification. */
export interface MeetingHistoryItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hasNotes: boolean;
  readonly notesRevision: number;
  readonly capture: { readonly status: "unavailable"; readonly durationMs?: number | null };
  readonly transcript: {
    readonly status: "none" | "retained";
    readonly revision: number;
    readonly segmentCount: number;
    readonly finalSegmentCount: number;
    readonly provisionalSegmentCount: number;
    /** Current text offsets, not recording duration or continuous coverage. */
    readonly span: { readonly startMs: number; readonly endMs: number } | null;
    readonly sources: readonly { readonly kind: "microphone" | "output"; readonly label: string }[];
    readonly omittedSourceCount: number;
  };
  readonly summary: {
    readonly overview?: string | null;
    readonly status: "none" | "available" | "stale";
    readonly version: number | null;
    readonly origin: "generated" | "manual" | null;
    readonly createdAt: string | null;
    readonly generation: {
      readonly status: "pending" | "failed" | "interrupted" | "saved";
      readonly expiresAt: string;
    } | null;
  };
  readonly actions: {
    readonly pending: number;
    readonly accepted: number;
    readonly dismissed: number;
  };
  readonly vault: {
    readonly latest: {
      readonly artifactVersion: number;
      readonly writeStatus: MeetingExportReceipt["writeStatus"];
      readonly indexStatus: MeetingExportReceipt["indexStatus"];
      readonly updatedAt: string;
    } | null;
    readonly savedVersionCount: number;
  };
}
const cursor = {
  type: "object",
  additionalProperties: false,
  required: ["id", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    createdAt: { type: "string", format: "date-time" }
  }
} as const;
export const searchMeetingHistorySchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 256 },
      filter: {
        type: "string",
        enum: ["all", "transcript", "needs-review", "exported", "notes-only"]
      },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      before: cursor
    }
  }
} as const;
export const getMeetingHistorySchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  }
} as const;
