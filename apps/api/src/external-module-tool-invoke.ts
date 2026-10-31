import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  consumeModulePageConfirmation,
  createModulePageConfirmation,
  recordModulePageActivity,
  sanitizeAssistantToolResult,
  screenToolResultData,
  summarizeAssistantToolInput,
  ToolInputValidationError,
  validateToolInput,
  type ConsumeModulePageConfirmationInput,
  type CreateModulePageConfirmationInput,
  type RecordModulePageActivityInput
} from "@moss/ai";
import { resolveMossEnv, type AccessContext, type DataContextDb } from "@moss/db";
import type {
  ModuleAssistantToolManifest,
  MossModuleManifest,
  ToolContext,
  ToolResult
} from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";

import { ExternalModuleReportedError } from "./external-module-tools.js";

export const MODULE_TOOL_INVOKE_ROUTE = "/api/modules/:moduleId/tools/:name/invoke";

const DEFAULT_MODULE_TOOL_MAX = 120;
const MAX_CONFIRMATION_ID_LENGTH = 64;
const MODULE_CODE = /^[a-z0-9._-]{1,64}$/;
const NOT_FOUND = { error: "Not found" } as const;

type ConfirmableRisk = CreateModulePageConfirmationInput["risk"];

export interface ModuleToolInvokeDeps {
  /** The API's auth runtime: session lookup and the trusted browser origins. */
  readonly auth: {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly trustedOrigins: readonly string[];
  };
  /** Manifests active for this actor; external ones carry worker-bound tools. */
  readonly resolveActiveModules: (actorUserId: string) => Promise<readonly MossModuleManifest[]>;
  readonly dataContext: {
    withDataContext<T>(access: AccessContext, work: (db: DataContextDb) => Promise<T>): Promise<T>;
  };
  readonly confirmations?: {
    readonly create: typeof createModulePageConfirmation;
    readonly consume: typeof consumeModulePageConfirmation;
  };
  readonly recordActivity?: typeof recordModulePageActivity;
  readonly rateLimitKey?: (request: FastifyRequest) => string;
}

interface InvokeBody {
  readonly input: Record<string, unknown>;
  readonly confirmationId?: string;
}

/**
 * A downloaded module's own page runs that module's tools here (#1699, #3723).
 *
 * Reads and unconfirmed writes run on the call. Outbound and destructive tools, and writes whose
 * own confirm rule matches or throws, return a single-use confirmation bound to the actor, module,
 * tool and validated input. The tool runs only on a second call that consumes it.
 */
export function registerModuleToolInvokeRoute(
  server: FastifyInstance,
  deps: ModuleToolInvokeDeps
): void {
  const confirmations = deps.confirmations ?? {
    create: createModulePageConfirmation,
    consume: consumeModulePageConfirmation
  };
  const recordActivity = deps.recordActivity ?? recordModulePageActivity;
  const baseKey = deps.rateLimitKey ?? sessionRateLimitKey;

  server.post<{ Params: { moduleId: string; name: string } }>(
    MODULE_TOOL_INVOKE_ROUTE,
    {
      config: {
        rateLimit: {
          max: Number(
            resolveMossEnv(process.env, "JARVIS_RL_MODULE_TOOL_MAX") ?? DEFAULT_MODULE_TOOL_MAX
          ),
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest) =>
            `${baseKey(request)}:${(request.params as { moduleId: string }).moduleId}`
        }
      }
    },
    async (request, reply) => {
      // A cookie POST that changes data. Browsers send Origin on every cross-site POST, so a
      // missing one is refused rather than trusted.
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !deps.auth.trustedOrigins.includes(origin)) {
        return reply
          .code(403)
          .send({ error: "Request origin is not trusted", code: "invalid_origin" });
      }

      let access: AccessContext;
      try {
        access = await deps.auth.resolveAccessContext(request);
      } catch {
        return reply.code(401).send({ error: "Session is missing or expired" });
      }

      const { moduleId, name } = request.params;
      const found = findExternalTool(
        await deps.resolveActiveModules(access.actorUserId),
        moduleId,
        name
      );
      if (!found) return reply.code(404).send(NOT_FOUND);
      const { module, tool } = found;

      const body = parseBody(request.body);
      if (!body) return reply.code(400).send({ error: "Invalid request" });

      let input: Record<string, unknown>;
      try {
        input = await validateToolInput(tool.inputSchema, body.input, {
          external: true,
          toolName: tool.name
        });
      } catch (error) {
        if (error instanceof ToolInputValidationError) {
          return reply.code(400).send({ error: "Invalid input" });
        }
        throw error;
      }

      const requestId = access.requestId ?? randomUUID();
      const ctx: ToolContext = { actorUserId: access.actorUserId, requestId, chatSessionId: "" };
      const inputSummary = summarizeAssistantToolInput(input);
      const risk = await confirmationRisk(deps, access, tool, input, ctx);

      if (risk !== null) {
        const inputDigest = digestToolInput(input);
        if (body.confirmationId === undefined) {
          const created = await deps.dataContext.withDataContext(access, (db) =>
            confirmations.create(db, {
              moduleId,
              moduleName: module.name,
              toolName: tool.name,
              permissionId: tool.permissionId,
              risk,
              inputSummary: { ...inputSummary },
              inputDigest,
              requestId
            })
          );
          return reply.code(409).send({
            invocation: { status: "blocked", reason: "confirmation_required" },
            confirmation: {
              id: created.id,
              expiresAt: created.expiresAt.toISOString(),
              moduleName: module.name,
              actionLabel: tool.actionLabel ?? tool.name,
              risk,
              inputSummary
            }
          });
        }
        // Its own transaction: the approval is spent before the tool runs, so a failed run can
        // never leave it reusable.
        const claim: ConsumeModulePageConfirmationInput = {
          id: body.confirmationId,
          moduleId,
          toolName: tool.name,
          inputDigest
        };
        const consumed = await deps.dataContext.withDataContext(access, (db) =>
          confirmations.consume(db, claim)
        );
        if (!consumed) return reply.code(409).send({ code: "confirmation_invalid" });
      }

      const record = async (
        outcome: RecordModulePageActivityInput["outcome"],
        errorClass: string | null,
        durationMs: number
      ): Promise<void> => {
        if (tool.risk === "read") return;
        try {
          await deps.dataContext.withDataContext(access, (db) =>
            recordActivity(db, {
              moduleId,
              toolName: tool.name,
              actionFamilyId: tool.actionFamilyId ?? null,
              actionKind: tool.risk as RecordModulePageActivityInput["actionKind"],
              approvalMode: risk === null ? "auto" : "confirmed",
              outcome,
              errorClass,
              inputSummary,
              durationMs,
              requestId
            })
          );
        } catch {
          // The write already ran. Failing the response would invite a duplicate retry.
          request.log.warn({ moduleId, toolName: tool.name }, "module page activity write failed");
        }
      };

      const startedAt = performance.now();
      const elapsed = () => Math.round(performance.now() - startedAt);
      let result: Record<string, unknown> | null;
      try {
        result = await deps.dataContext.withDataContext(access, async (db) => {
          const raw = await tool.execute!(db, input, ctx, {});
          const toolResult: ToolResult = { ...raw, data: raw.data ?? {} };
          return screenToolResultData(sanitizeAssistantToolResult(tool.outputSchema, toolResult));
        });
      } catch (error) {
        if (error instanceof ExternalModuleReportedError) {
          await record("failed", "module_rejected", elapsed());
          const moduleCode =
            typeof error.code === "string" && MODULE_CODE.test(error.code) ? error.code : undefined;
          return reply
            .code(422)
            .send({ code: "module_rejected", ...(moduleCode ? { moduleCode } : {}) });
        }
        await record("failed", "handler_error", elapsed());
        request.log.warn(
          { moduleId, toolName: tool.name, errorClass: "handler_error" },
          "module page tool failed"
        );
        return reply.code(502).send({ error: "The module could not finish that" });
      }

      // The tool ran. A result too large to return is still a completed write.
      await record("success", null, elapsed());
      if (result === null) {
        return reply.code(413).send({ error: "The tool result is too large to show" });
      }
      return reply.code(200).send({ invocation: { status: "succeeded", result } });
    }
  );
}

/** The tool only when it is a worker-bound tool of this active downloaded module. */
function findExternalTool(
  manifests: readonly MossModuleManifest[],
  moduleId: string,
  name: string
): { module: MossModuleManifest; tool: ModuleAssistantToolManifest } | undefined {
  const module = manifests.find((candidate) => candidate.id === moduleId);
  const tool = module?.assistantTools?.find((candidate) => candidate.name === name);
  if (!module || !tool || tool.isExternal !== true || typeof tool.execute !== "function") {
    return undefined;
  }
  return { module, tool };
}

/** Null when the tool runs on the call; otherwise the risk a person must confirm. */
async function confirmationRisk(
  deps: ModuleToolInvokeDeps,
  access: AccessContext,
  tool: ModuleAssistantToolManifest,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ConfirmableRisk | null> {
  if (tool.risk === "read") return null;
  if (tool.risk !== "write") return tool.risk;
  const hook = tool.requiresConfirmation;
  if (!hook) return null;
  try {
    const confirm = await deps.dataContext.withDataContext(access, (db) =>
      Promise.resolve(hook(db, input, ctx))
    );
    return confirm === false ? null : "write";
  } catch {
    return "write";
  }
}

function parseBody(body: unknown): InvokeBody | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).some((key) => key !== "input" && key !== "confirmationId")) return null;
  if (!isRecord(body.input)) return null;
  const { confirmationId } = body;
  if (confirmationId === undefined) return { input: body.input };
  if (
    typeof confirmationId !== "string" ||
    confirmationId.length === 0 ||
    confirmationId.length > MAX_CONFIRMATION_ID_LENGTH
  ) {
    return null;
  }
  return { input: body.input, confirmationId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SHA-256 of validated input with object keys sorted at every depth. */
export function digestToolInput(input: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalJson(input)).digest();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
