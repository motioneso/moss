import type { ToolExecute } from "@moss/module-sdk";
import { hostDiagnosticsSchema } from "@moss/shared";

type DiagnosticSection = "version" | "runtime" | "modules" | "errors" | "actions" | "source";

interface PlatformDiagnosticsReport {
  readonly observedAt: string;
  readonly build: { readonly version: string; readonly buildId: string };
  readonly runtime: Record<string, unknown> | null;
  readonly modules: readonly Record<string, unknown>[];
  readonly errors: readonly Record<string, unknown>[];
  readonly actions: readonly Record<string, unknown>[];
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
    }
  ): Promise<PlatformDiagnosticsReport>;
}

const DIAGNOSTIC_SECTIONS: readonly DiagnosticSection[] = [
  "version",
  "runtime",
  "modules",
  "errors",
  "actions",
  "source"
];
const INPUT_KEYS = new Set(["question", "module", "include", "limit"]);

export const platformDiagnosticsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string", maxLength: 240 },
    module: { type: "string", maxLength: 120 },
    include: {
      type: "array",
      maxItems: 6,
      items: { type: "string", enum: DIAGNOSTIC_SECTIONS }
    },
    limit: { type: "integer", minimum: 1, maximum: 10 }
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
    compiledGeneration: { type: "number" }
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
  const service = services?.platformDiagnostics as PlatformDiagnosticsReadService | undefined;
  if (!service) throw new Error("platform diagnostics read service is unavailable");
  return {
    data: (await service.observe(scopedDb, ctx, {
      ...(question ? { query: question } : {}),
      ...(module ? { domain: module } : {}),
      ...(include ? { include: include as DiagnosticSection[] } : {}),
      ...(limit !== undefined ? { limit } : {})
    })) as unknown as Record<string, unknown>
  };
};
