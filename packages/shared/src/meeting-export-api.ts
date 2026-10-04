/** Explicit private copies; a new artifact version creates a separate note, never overwrites. */
export interface ExportMeetingOutputInput {
  readonly requestKey: string;
  readonly artifactVersion: number;
}
export interface MeetingExportReceipt {
  readonly meetingId: string;
  readonly artifactVersion: number;
  readonly destination: "private-vault";
  readonly audience: "owner";
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly noteReference: string | null;
  readonly writeStatus: "pending" | "saved" | "failed" | "conflict";
  readonly indexStatus: "not-requested" | "queued" | "delayed" | "conflict";
  readonly indexJobId: string | null;
  readonly errorCode:
    | "meeting_vault_write_failed"
    | "meeting_vault_conflict"
    | "meeting_index_delayed"
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export const exportMeetingOutputSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["requestKey", "artifactVersion"],
    properties: {
      requestKey: { type: "string", format: "uuid" },
      artifactVersion: { type: "integer", minimum: 1, maximum: 1000 }
    }
  }
} as const;
