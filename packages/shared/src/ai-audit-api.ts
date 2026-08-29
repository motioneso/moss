const actionAuditInputSummarySchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["inputKeys", "inputKeyCount", "truncated"],
  properties: {
    inputKeys: { type: "array", items: { type: "string" } },
    inputKeyCount: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" }
  }
} as const;

const actionAuditLogEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "ownerUserId",
    "toolModuleId",
    "toolName",
    "actionFamilyId",
    "actionKind",
    "approvalMode",
    "outcome",
    "errorClass",
    "requestId",
    "chatSessionId",
    "sourceSurface",
    "inputSummary",
    "occurredAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    toolModuleId: { type: "string" },
    toolName: { type: "string" },
    actionFamilyId: { type: ["string", "null"] },
    actionKind: { type: "string", enum: ["write", "outbound", "destructive"] },
    approvalMode: {
      type: "string",
      enum: ["auto", "yolo", "confirmed", "rejected", "cancelled", "timeout"]
    },
    outcome: {
      type: "string",
      enum: ["success", "failed", "denied", "cancelled", "invalid", "conflict"]
    },
    errorClass: { type: ["string", "null"] },
    requestId: { type: ["string", "null"] },
    chatSessionId: { type: ["string", "null"] },
    sourceSurface: {
      type: "string",
      enum: ["chat", "proactive", "scheduled", "unknown"]
    },
    inputSummary: actionAuditInputSummarySchema,
    occurredAt: { type: "string" }
  }
} as const;

export const listActionAuditLogResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: { type: "array", items: actionAuditLogEntrySchema }
  }
} as const;

export const listActionAuditLogRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      since: { type: "string" },
      family: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 }
    }
  },
  response: {
    200: listActionAuditLogResponseSchema
  }
} as const;

export type ActionAuditLogEntryDto = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly toolModuleId: string;
  readonly toolName: string;
  readonly actionFamilyId: string | null;
  readonly actionKind: "write" | "outbound" | "destructive";
  readonly approvalMode: "auto" | "yolo" | "confirmed" | "rejected" | "cancelled" | "timeout";
  readonly outcome: "success" | "failed" | "denied" | "cancelled" | "invalid" | "conflict";
  readonly errorClass: string | null;
  readonly requestId: string | null;
  readonly chatSessionId: string | null;
  readonly sourceSurface: "chat" | "proactive" | "scheduled" | "unknown";
  readonly inputSummary: ActionAuditInputSummary | null;
  readonly occurredAt: string;
};

export type ActionAuditInputSummary = {
  readonly inputKeys: readonly string[];
  readonly inputKeyCount: number;
  readonly truncated: boolean;
};

export type ListActionAuditLogResponse = {
  readonly entries: readonly ActionAuditLogEntryDto[];
};
