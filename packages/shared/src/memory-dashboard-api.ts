const recordKindEnum = [
  "fact",
  "preference",
  "goal",
  "constraint",
  "decision",
  "relationship",
  "alias",
  "inference"
] as const;

const sourceKindEnum = ["chat", "note", "task", "email", "calendar", "manual"] as const;

const dashboardStatusEnum = [
  "pending",
  "promoted",
  "merged",
  "active",
  "archived",
  "stale",
  "expired",
  "superseded",
  "rejected",
  "suppressed",
  "conflicting",
  "history",
  "inactive",
  "all"
] as const;

const dashboardItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "itemKind",
    "id",
    "title",
    "summary",
    "status",
    "sourceSummary",
    "sourceKind",
    "createdAt",
    "updatedAt",
    "editableFields"
  ],
  properties: {
    itemKind: { type: "string", enum: ["candidate", "fact", "entity"] },
    id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    recordKind: { type: "string", enum: recordKindEnum },
    entityKind: {
      type: "string",
      enum: [
        "person",
        "project",
        "preference",
        "goal",
        "constraint",
        "decision",
        "topic",
        "place",
        "organization",
        "self"
      ]
    },
    status: { type: "string" },
    confidence: { type: "number" },
    confidenceTier: { type: "string", enum: ["confirmed", "high", "medium", "low"] },
    provenance: {
      type: "string",
      enum: ["volunteered", "inferred", "confirmed", "imported"]
    },
    sourceSummary: { type: "string" },
    sourceKind: { type: "string", enum: sourceKindEnum },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    staleAt: { type: ["string", "null"] },
    validFrom: { type: ["string", "null"] },
    validTo: { type: ["string", "null"] },
    conflictGroupId: { type: ["string", "null"] },
    supersededByFactId: { type: ["string", "null"] },
    pinned: { type: "boolean" },
    editableFields: { type: "array", items: { type: "string" } }
  }
} as const;

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: { error: { type: "string" } }
} as const;

export const getMemoryDashboardRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: dashboardStatusEnum },
      recordKind: { type: "string", enum: recordKindEnum },
      sourceKind: { type: "string", enum: sourceKindEnum },
      q: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["counts", "items"],
      properties: {
        counts: { type: "object", additionalProperties: { type: "number" } },
        items: { type: "array", items: dashboardItemSchema },
        nextCursor: { type: "string" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

const pendingCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "title",
    "summary",
    "titleTruncated",
    "summaryTruncated",
    "provenance",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    title: { type: "string", maxLength: 120 },
    summary: { type: "string", maxLength: 200 },
    titleTruncated: { type: "boolean" },
    summaryTruncated: { type: "boolean" },
    recordKind: { type: "string", enum: recordKindEnum },
    provenance: { type: "string", enum: ["volunteered", "inferred"] },
    createdAt: { type: "string" }
  }
} as const;

export const getMemoryPendingCandidatesRouteSchema = {
  querystring: {
    type: "object",
    description:
      "List five pending suggestions at a time. Start at offset 0, then pass the returned nextOffset to read the next page.",
    additionalProperties: false,
    properties: {
      offset: { type: "integer", minimum: 0, maximum: 2147483647, default: 0 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["total", "hasMore", "remainingCount", "nextOffset", "items"],
      properties: {
        total: { type: "integer", minimum: 0 },
        hasMore: { type: "boolean" },
        remainingCount: { type: "integer", minimum: 0 },
        nextOffset: { type: ["integer", "null"], minimum: 0 },
        items: { type: "array", items: pendingCandidateSchema }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const postMemoryCandidateAcceptRouteSchema = {
  body: {
    type: "object",
    description: "Add the accepted suggestion as a new memory. Existing memories are kept.",
    additionalProperties: false,
    properties: {
      edited: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          recordKind: { type: "string", enum: recordKindEnum },
          validFrom: { type: ["string", "null"] },
          validTo: { type: ["string", "null"] },
          staleAt: { type: ["string", "null"] },
          pinned: { type: "boolean" },
          entityName: { type: "string" },
          entitySummary: { type: ["string", "null"] }
        }
      }
    }
  },
  response: {
    200: {
      type: "object",
      properties: { accepted: { type: "boolean" } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const postMemoryCandidateRejectRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string" }
    }
  },
  response: {
    204: {},
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const postMemoryCandidateSuppressRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string" }
    }
  },
  response: {
    204: {},
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const patchMemoryFactDashboardRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      validFrom: { type: ["string", "null"] },
      validTo: { type: ["string", "null"] },
      staleAt: { type: ["string", "null"] },
      pinned: { type: "boolean" }
    }
  },
  response: {
    200: {
      type: "object",
      properties: { patched: { type: "boolean" } }
    },
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const patchMemoryEntityDashboardRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      summary: { type: ["string", "null"] },
      status: { type: "string", enum: ["active", "archived"] }
    }
  },
  response: {
    200: {
      type: "object",
      properties: { patched: { type: "boolean" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const deleteMemoryEntityDashboardRouteSchema = {
  response: {
    204: {},
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;
