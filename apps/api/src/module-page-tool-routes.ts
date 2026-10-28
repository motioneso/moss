import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  consumeModulePageConfirmation,
  createModulePageConfirmation,
  sanitizeAssistantToolResult,
  screenToolResultData,
  summarizeAssistantToolInput,
  validateToolInput,
  type AiRepository,
  type InsertAuditLogInput
} from "@moss/ai";
import { resolveMossEnv, type AccessContext, type DataContextRunner } from "@moss/db";
import { readActorLocale } from "@moss/settings";
import type { MossModuleManifest, ToolContext } from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";
import { ExternalModuleReportedError } from "./external-module-tools.js";
import { modulePageInputDigest, modulePageInvokeBody } from "./module-page-tool-input.js";

interface Dependencies {
  readonly runner: DataContextRunner;
  readonly repository: Pick<AiRepository, "insertActionAuditLog">;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly resolveActiveModules: (actorUserId: string) => Promise<readonly MossModuleManifest[]>;
  readonly getExternalModuleIds: () => ReadonlySet<string>;
  readonly trustedOrigins: readonly string[];
}

/** Page-owned calls use the approved risk rules, never the assistant's autonomy tier. */
export function registerModulePageToolRoutes(server: FastifyInstance, deps: Dependencies): void {
  const configuredMax = Number(resolveMossEnv(process.env, "JARVIS_RL_MODULE_TOOL_MAX") ?? 120);
  const max = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 120;
  server.post<{ Params: { moduleId: string; name: string } }>(
    "/api/modules/:moduleId/tools/:name/invoke",
    {
      config: {
        rateLimit: {
          max,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest) =>
            `module-tool:${sessionRateLimitKey(request)}:${(request.params as { moduleId: string }).moduleId}`
        }
      }
    },
    async (request, reply) => {
      let access: AccessContext;
      try {
        access = await deps.resolveAccessContext(request);
      } catch {
        return reply.code(401).send({ error: "Session is missing or expired" });
      }
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !deps.trustedOrigins.includes(origin))
        return reply.code(403).send({ code: "invalid_origin" });
      const { moduleId, name } = request.params;
      try {
        const modules = await deps.resolveActiveModules(access.actorUserId);
        const found = modules
          .flatMap((module) => (module.assistantTools ?? []).map((tool) => ({ module, tool })))
          .find(({ tool }) => tool.name === name);
        if (
          !deps.getExternalModuleIds().has(moduleId) ||
          !found ||
          found.module.id !== moduleId ||
          found.tool.isExternal !== true ||
          !found.tool.execute
        )
          return reply.code(404).send({ error: "Not found" });
        const { module, tool } = found;
        const body = modulePageInvokeBody(request.body);
        if (!body) return reply.code(400).send({ error: "Invalid input" });
        let input: Record<string, unknown>;
        let digest: Buffer;
        try {
          input = await validateToolInput(tool.inputSchema, body.input, {
            external: true,
            toolName: tool.name
          });
          digest = modulePageInputDigest(input);
        } catch {
          return reply.code(400).send({ error: "Invalid input" });
        }
        const locale = await deps.runner.withDataContext(access, readActorLocale);
        const ctx: ToolContext = {
          locale,
          localTimezone: locale.timezone,
          actorUserId: access.actorUserId,
          requestId: access.requestId ?? request.id,
          chatSessionId: ""
        };
        const forcedInput = { ...input, actorUserId: access.actorUserId };
        const inputSummary = summarizeAssistantToolInput(input);
        let requiresConfirmation = tool.risk === "destructive" || tool.risk === "outbound";
        if (tool.risk === "write" && tool.requiresConfirmation) {
          try {
            requiresConfirmation =
              (await deps.runner.withDataContext(access, (scope) =>
                Promise.resolve(tool.requiresConfirmation!(scope, forcedInput, ctx))
              )) !== false;
          } catch {
            requiresConfirmation = true;
          }
        }
        if (body.confirmationId !== undefined) {
          // This transaction commits BEFORE execution. A later failure cannot revive approval.
          const consumed = await deps.runner.withDataContext(access, (scope) =>
            consumeModulePageConfirmation(scope, {
              id: body.confirmationId!,
              moduleId,
              toolName: tool.name,
              inputDigest: digest
            })
          );
          if (!consumed) return reply.code(409).send({ code: "confirmation_invalid" });
        } else if (requiresConfirmation && tool.risk !== "read") {
          const confirmation = await deps.runner.withDataContext(access, (scope) =>
            createModulePageConfirmation(scope, {
              moduleId,
              moduleName: module.name,
              toolName: tool.name,
              permissionId: tool.permissionId,
              risk: tool.risk as "write" | "outbound" | "destructive",
              inputSummary,
              inputDigest: digest,
              requestId: ctx.requestId
            })
          );
          return reply.code(409).send({
            invocation: { status: "blocked", reason: "confirmation_required" },
            confirmation: {
              id: confirmation.id,
              expiresAt: confirmation.expiresAt.toISOString(),
              moduleName: module.name.slice(0, 160),
              actionLabel: (tool.actionLabel ?? tool.name).slice(0, 240),
              risk: tool.risk,
              inputSummary
            }
          });
        }

        const startedAt = performance.now();
        let statusCode = 200;
        let response: Record<string, unknown>;
        let outcome: InsertAuditLogInput["outcome"] = "success";
        let errorClass: string | null = null;
        try {
          const raw = await deps.runner.withDataContext(access, (scope) =>
            tool.execute!(scope, forcedInput, ctx)
          );
          const result = screenToolResultData(sanitizeAssistantToolResult(tool.outputSchema, raw));
          if (result === null) {
            statusCode = 413;
            response = { error: "The tool result is too large to show" };
            outcome = "failed";
            errorClass = "result_too_large";
          } else response = { invocation: { status: "succeeded", result } };
        } catch (error) {
          outcome = "failed";
          if (error instanceof ExternalModuleReportedError) {
            statusCode = 422;
            errorClass = "module_reported";
            response = {
              code: "module_rejected",
              ...(error.code && /^[a-z][a-z0-9._-]{0,63}$/.test(error.code)
                ? { moduleCode: error.code }
                : {})
            };
          } else {
            statusCode = 503;
            errorClass = "execution_failed";
            response = { error: "The action could not be completed" };
          }
        }
        if (tool.risk !== "read") {
          // Same owner-scoped audit writer used by chat; no raw inputs or results are persisted.
          await deps.runner.withDataContext(access, (scope) =>
            deps.repository.insertActionAuditLog(scope, {
              id: randomUUID(),
              ownerUserId: access.actorUserId,
              toolModuleId: moduleId,
              toolName: tool.name,
              actionFamilyId: tool.actionFamilyId ?? null,
              actionKind: tool.risk as "write" | "outbound" | "destructive",
              approvalMode: body.confirmationId ? "confirmed" : "auto",
              outcome,
              errorClass,
              requestId: ctx.requestId,
              chatSessionId: null,
              sourceSurface: "module_page",
              inputSummary,
              durationMs: Math.max(0, Math.round(performance.now() - startedAt))
            })
          );
        }
        return reply.code(statusCode).send(response);
      } catch {
        // A failed response can follow an executed write. The host must never retry blindly.
        request.log.warn({ moduleId, toolName: name }, "module page invocation unavailable");
        return reply.code(503).send({ error: "The action could not be completed" });
      }
    }
  );
}
