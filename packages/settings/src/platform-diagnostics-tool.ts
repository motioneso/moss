import type { ConnectionsSection, JobsSection, LogsSection, ToolExecute } from "@moss/module-sdk";
import { hostDiagnosticsSchema } from "@moss/shared";

type DiagnosticSection =
  | "version"
  | "runtime"
  | "modules"
  | "errors"
  | "actions"
  | "jobs"
  | "connections"
  | "logs"
  | "source";

interface PlatformDiagnosticsReport {
  readonly observedAt: string;
  readonly build: { readonly version: string; readonly buildId: string };
  readonly runtime: Record<string, unknown> | null;
  readonly modules: readonly Record<string, unknown>[];
  readonly errors: readonly Record<string, unknown>[];
  readonly actions: readonly Record<string, unknown>[];
  readonly jobs: JobsSection;
  readonly connections: ConnectionsSection;
  readonly logs: LogsSection;
  readonly source: {
    readonly matches: readonly {
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly text: string;
    }[];
    readonly filesScanned: number;
    readonly truncated: boolean;
    readonly rejected: readonly { readonly path: string; readonly reason: string }[];
  } | null;
  readonly redactions: readonly string[];
}

interface PlatformDiagnosticsReadService {
  observe(
    scopedDb: unknown,
    ctx: { readonly actorUserId: string; readonly requestId: string },
    query?: {
      readonly domain?: string;
      readonly include?: readonly DiagnosticSection[];
      readonly query?: string;
      readonly limit?: number;
      readonly logs?: {
        readonly sinceMinutes?: number;
        readonly minLevel?: "warn" | "error" | "fatal";
        readonly component?: string;
        readonly connectionKind?: string;
      };
    }
  ): Promise<PlatformDiagnosticsReport>;
}

const DIAGNOSTIC_SECTIONS: readonly DiagnosticSection[] = [
  "version",
  "runtime",
  "modules",
  "errors",
  "actions",
  "jobs",
  "connections",
  "logs",
  "source"
];
const LOG_LEVELS = ["warn", "error", "fatal"] as const;
const INPUT_KEYS = new Set(["question", "module", "include", "limit", "logs"]);

export const platformDiagnosticsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string", maxLength: 240 },
    module: { type: "string", maxLength: 120 },
    include: {
      type: "array",
      maxItems: 9,
      items: { type: "string", enum: DIAGNOSTIC_SECTIONS }
    },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    logs: {
      type: "object",
      additionalProperties: false,
      properties: {
        sinceMinutes: { type: "integer", minimum: 1, maximum: 1440 },
        minLevel: { type: "string", enum: LOG_LEVELS },
        component: {
          type: "string",
          maxLength: 80,
          description: "Leave unset on the first call. Only use a label an earlier result showed."
        },
        connectionKind: {
          type: "string",
          maxLength: 40,
          description: "Leave unset on the first call. Most records carry no connection kind."
        }
      }
    }
  }
} as const;

const nullableString = { type: ["string", "null"] } as const;
const diagnosticFactsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string" },
    failureKind: nullableString,
    lastFailureKind: nullableString,
    lastRequestedAt: nullableString,
    lastAttemptAt: nullableString,
    lastSuccessAt: nullableString,
    lastFailureAt: nullableString,
    snapshotAgeSeconds: { type: ["number", "null"] },
    itemCount: { type: ["number", "null"] },
    requestedGeneration: { type: "number" },
    compiledGeneration: { type: "number" },
    // News provenance. Story counts are null when the saved feed is missing or expired.
    totalStories: { type: ["number", "null"] },
    storiesHiddenFromSavedFeed: { type: ["number", "null"] },
    storiesFromBuiltInSources: { type: ["number", "null"] },
    storiesFromAddedSources: { type: ["number", "null"] },
    storiesFoundByTopicSearch: { type: ["number", "null"] },
    storiesMatchingFollowedTopic: { type: ["number", "null"] },
    addedSourceCount: { type: "number" },
    followedTopicCount: { type: "number" },
    excludedSourceCount: { type: "number" },
    dismissalsApplied: { type: "boolean" }
  }
} as const;
const diagnosticObservationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["domain", "providerId", "observedAt", "status", "summary"],
  properties: {
    domain: { type: "string" },
    providerId: { type: "string" },
    observedAt: { type: "string" },
    status: { type: "string", enum: ["ok", "degraded", "failed", "unknown"] },
    summary: { type: "string" },
    remediationActionId: { type: "string" },
    facts: diagnosticFactsSchema
  }
} as const;
const errorObservationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "occurredAt",
    "feature",
    "operation",
    "errorCategory",
    "retryable",
    "userMessage",
    "internalSummary",
    "requestId"
  ],
  properties: {
    occurredAt: { type: "string" },
    feature: { type: "string" },
    operation: { type: "string" },
    errorCategory: { type: "string" },
    retryable: { type: "boolean" },
    userMessage: { type: "string" },
    internalSummary: { type: "string" },
    requestId: nullableString
  }
} as const;
const actionObservationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "occurredAt",
    "toolModuleId",
    "toolName",
    "actionKind",
    "approvalMode",
    "outcome",
    "errorClass",
    "requestId"
  ],
  properties: {
    occurredAt: { type: "string" },
    toolModuleId: { type: "string" },
    toolName: { type: "string" },
    actionKind: { type: "string" },
    approvalMode: { type: "string" },
    outcome: { type: "string" },
    errorClass: nullableString,
    requestId: nullableString
  }
} as const;
const labelString = { type: "string", maxLength: 120 } as const;
const nullableLabel = { type: ["string", "null"], maxLength: 120 } as const;
const jobsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["recent", "summaries", "truncated"],
  properties: {
    recent: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "occurredAt",
          "queue",
          "state",
          "retryCount",
          "ownerKnown",
          "kind",
          "connectorAccountId",
          "errorLabel"
        ],
        properties: {
          occurredAt: { type: "string" },
          queue: labelString,
          state: labelString,
          retryCount: { type: "number" },
          ownerKnown: { type: "boolean" },
          kind: nullableLabel,
          connectorAccountId: nullableLabel,
          errorLabel: nullableLabel
        }
      }
    },
    summaries: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "queue",
          "lastSuccessAt",
          "lastFailureAt",
          "failedLast24h",
          "stuckCount",
          "activeCount"
        ],
        properties: {
          queue: labelString,
          lastSuccessAt: nullableString,
          lastFailureAt: nullableString,
          failedLast24h: { type: "number" },
          stuckCount: { type: "number" },
          activeCount: { type: "number" }
        }
      }
    },
    truncated: { type: "boolean" }
  }
} as const;
const connectionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "truncated"],
  properties: {
    items: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "provider",
          "accountId",
          "status",
          "lastAttemptAt",
          "lastGoodAt",
          "failureCount",
          "errorLabel"
        ],
        properties: {
          provider: labelString,
          accountId: labelString,
          status: labelString,
          lastAttemptAt: nullableString,
          lastGoodAt: nullableString,
          failureCount: { type: "number" },
          errorLabel: nullableLabel
        }
      }
    },
    truncated: { type: "boolean" }
  }
} as const;
const logsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["records", "coverage", "truncated"],
  properties: {
    records: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "occurredAt",
          "process",
          "level",
          "component",
          "connectionKind",
          "eventCode",
          "ownerKnown",
          "owned",
          "message",
          "truncated"
        ],
        properties: {
          occurredAt: { type: "string" },
          process: { type: "string", enum: ["api", "worker"] },
          level: { type: "string", enum: LOG_LEVELS },
          component: { type: "string", maxLength: 80 },
          connectionKind: { type: ["string", "null"], maxLength: 40 },
          eventCode: { type: ["string", "null"], maxLength: 80 },
          ownerKnown: { type: "boolean" },
          owned: { type: "boolean" },
          message: { type: ["string", "null"], maxLength: 500 },
          truncated: { type: "boolean" }
        }
      }
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: ["oldestAt", "newestAt"],
      properties: { oldestAt: nullableString, newestAt: nullableString }
    },
    truncated: { type: "boolean" }
  }
} as const;
const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["matches", "filesScanned", "truncated", "rejected"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "startLine", "endLine", "text"],
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          text: { type: "string" }
        }
      }
    },
    filesScanned: { type: "number" },
    truncated: { type: "boolean" },
    rejected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason"],
        properties: { path: { type: "string" }, reason: { type: "string" } }
      }
    }
  }
} as const;

export const platformDiagnosticsOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "observedAt",
    "build",
    "runtime",
    "modules",
    "errors",
    "actions",
    "jobs",
    "connections",
    "logs",
    "source",
    "redactions"
  ],
  properties: {
    observedAt: { type: "string" },
    build: {
      type: "object",
      additionalProperties: false,
      required: ["version", "buildId"],
      properties: { version: { type: "string" }, buildId: { type: "string" } }
    },
    runtime: { anyOf: [{ type: "null" }, hostDiagnosticsSchema] },
    modules: { type: "array", items: diagnosticObservationSchema },
    errors: { type: "array", items: errorObservationSchema },
    actions: { type: "array", items: actionObservationSchema },
    jobs: jobsSchema,
    connections: connectionsSchema,
    logs: logsSchema,
    source: { anyOf: [{ type: "null" }, sourceSchema] },
    redactions: { type: "array", items: { type: "string" } }
  }
} as const;

function boundedString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`platform diagnostics ${name} must be at most ${maxLength} characters`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseLogsInput(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("platform diagnostics logs must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["sinceMinutes", "minLevel", "component", "connectionKind"].includes(key)) {
      throw new Error(`platform diagnostics logs does not accept ${key}`);
    }
  }
  if (
    input.sinceMinutes !== undefined &&
    (typeof input.sinceMinutes !== "number" ||
      !Number.isInteger(input.sinceMinutes) ||
      input.sinceMinutes < 1 ||
      input.sinceMinutes > 1440)
  ) {
    throw new Error("platform diagnostics logs sinceMinutes must be an integer from 1 to 1440");
  }
  if (
    input.minLevel !== undefined &&
    !LOG_LEVELS.includes(input.minLevel as (typeof LOG_LEVELS)[number])
  ) {
    throw new Error("platform diagnostics logs minLevel must be warn, error or fatal");
  }
  const component = boundedString(input.component, "logs component", 80);
  const connectionKind = boundedString(input.connectionKind, "logs connectionKind", 40);
  return {
    ...(input.sinceMinutes !== undefined ? { sinceMinutes: input.sinceMinutes as number } : {}),
    ...(input.minLevel !== undefined
      ? { minLevel: input.minLevel as (typeof LOG_LEVELS)[number] }
      : {}),
    ...(component ? { component } : {}),
    ...(connectionKind ? { connectionKind } : {})
  };
}

export const platformDiagnosticsExecute: ToolExecute = async (scopedDb, input, ctx, services) => {
  const raw = (input ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!INPUT_KEYS.has(key)) throw new Error(`platform diagnostics does not accept ${key}`);
  }
  const question = boundedString(raw.question, "question", 240);
  const module = boundedString(raw.module, "module", 120);
  const include = raw.include === undefined ? undefined : raw.include;
  if (
    include !== undefined &&
    (!Array.isArray(include) ||
      include.length > DIAGNOSTIC_SECTIONS.length ||
      include.some((section) => !DIAGNOSTIC_SECTIONS.includes(section as DiagnosticSection)))
  ) {
    throw new Error("platform diagnostics include contains an unsupported section");
  }
  const limit =
    typeof raw.limit === "number" ? Math.max(1, Math.min(10, Math.floor(raw.limit))) : undefined;
  const logs = parseLogsInput(raw.logs);
  const service = services?.platformDiagnostics as PlatformDiagnosticsReadService | undefined;
  if (!service) throw new Error("platform diagnostics read service is unavailable");
  return {
    data: (await service.observe(scopedDb, ctx, {
      ...(question ? { query: question } : {}),
      ...(module ? { domain: module } : {}),
      ...(include ? { include: include as DiagnosticSection[] } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(logs ? { logs } : {})
    })) as unknown as Record<string, unknown>
  };
};
