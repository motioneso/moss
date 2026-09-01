import { randomUUID } from "node:crypto";

import type { AccessContext, DataContextRunner, JsonSecretCipher } from "@moss/db";
import type {
  ModuleAssistantToolManifest,
  MossModuleManifest,
  ToolContext,
  ToolExecute,
  ToolResult
} from "@moss/module-sdk";

import {
  callMemory,
  requestBudget,
  type CallMemory,
  type RequestBudget
} from "./call-memory.js";
import { effectiveEnabledTools } from "./curation.js";
import { capChars, INTEGRATION_RESPONSE_CHAR_CAP } from "./limits.js";
import { callMcpTool } from "./mcp-client.js";
import type { DiscoveredTool } from "./openapi-convert.js";
import { invokeOpenApiTool } from "./openapi-invoke.js";
import { IntegrationsRepository, type ConnectionRow } from "./repository.js";
import { INTEGRATION_SUMMARY } from "./summaries.js";

export { INTEGRATION_SUMMARY } from "./summaries.js";

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

/** Fixed shape every integration tool result is wrapped in, whatever the service kind (#2175 Task 2). */
export interface IntegrationOutcomeEnvelope {
  readonly status: "ok" | "error";
  readonly action: "performed" | "read";
  readonly summary: string;
  readonly detail: unknown;
}

/** Minimal logger shape this module needs — matches FastifyBaseLogger's warn signature. */
export interface ToolManifestLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface IntegrationsActiveModulesResolverDeps {
  readonly dataContext: DataContextRunner;
  readonly cipher: JsonSecretCipher;
  readonly logger: ToolManifestLogger;
  /** Test seam — defaults to a real IntegrationsRepository. */
  readonly repository?: IntegrationsRepository;
  /** Test seam — defaults to the module-level `callMemory` singleton (#2175 Task 3). */
  readonly callMemory?: CallMemory;
  /** Test seam — defaults to the module-level `requestBudget` singleton (#2175 Task 4). */
  readonly requestBudget?: RequestBudget;
}

type ActiveModulesResolver = (actorUserId: string) => Promise<readonly MossModuleManifest[]>;

export function connectionSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connection"
  );
}

function hasRootCombinator(schema: Record<string, unknown> | null): boolean {
  return schema !== null && ROOT_COMBINATORS.some((key) => key in schema);
}

/**
 * Wraps an existing ActiveModulesResolver, appending one synthetic MossModuleManifest per
 * enabled connection that has at least one curated-in tool (Task 8, #2162). Base entries pass
 * through untouched. Each synthetic tool proxies to the connection's MCP server or OpenAPI
 * endpoint at call time — no static assistantTools list exists for this module (see
 * manifest.ts), because the tool set is per-user and only known once connections are read.
 */
export function createIntegrationsActiveModulesResolver(
  base: ActiveModulesResolver,
  deps: IntegrationsActiveModulesResolverDeps
): ActiveModulesResolver {
  const repository = deps.repository ?? new IntegrationsRepository();

  return async (actorUserId: string) => {
    const modules = await base(actorUserId);
    const accessContext: AccessContext = { actorUserId, requestId: `int_${randomUUID()}` };
    const connections = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
      repository.listConnections(scopedDb)
    );

    const synthetic: MossModuleManifest[] = [];
    for (const conn of connections.filter((c) => c.enabled && c.discoveredTools.length > 0)) {
      const slug = connectionSlug(conn.name);
      const state = {
        enabledGroups: conn.enabledGroups,
        enabledTools: conn.enabledTools,
        mutedTools: conn.mutedTools
      };
      const tools: ModuleAssistantToolManifest[] = [];
      for (const tool of effectiveEnabledTools(conn.discoveredTools, state)) {
        if (hasRootCombinator(tool.inputSchema)) {
          deps.logger.warn(
            { connection: conn.name, tool: tool.name },
            "integration tool skipped: top-level schema combinator"
          );
          continue;
        }
        tools.push(buildToolManifest(conn, slug, tool as DiscoveredTool, deps, repository));
      }
      if (tools.length > 0) synthetic.push(buildSyntheticModule(conn, slug, tools));
    }

    return [...modules, ...synthetic];
  };
}

function buildToolManifest(
  conn: ConnectionRow,
  slug: string,
  tool: DiscoveredTool,
  deps: IntegrationsActiveModulesResolverDeps,
  repository: IntegrationsRepository
): ModuleAssistantToolManifest {
  const memory = deps.callMemory ?? callMemory;
  const budget = deps.requestBudget ?? requestBudget;
  const action: IntegrationOutcomeEnvelope["action"] =
    tool.readOnly === true ? "read" : "performed";
  const skipSuppression = tool.idempotent === true || conn.unsuppressedTools.includes(tool.name);

  const execute: ToolExecute = async (scopedDb, input, ctx: ToolContext): Promise<ToolResult> => {
    const scope = { actorUserId: ctx.actorUserId, chatSessionId: ctx.chatSessionId };
    const key = memory.callKey(conn.id, tool.name, input);
    const decision = memory.check(scope, conn.id, key, action, skipSuppression);
    if (decision.kind === "serve") {
      const envelope: IntegrationOutcomeEnvelope = {
        status: "ok",
        action,
        summary: decision.summary,
        detail: decision.detail
      };
      return { data: envelope as unknown as Record<string, unknown> };
    }

    const budgetScope = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    if (!budget.reserveCall(budgetScope)) {
      const envelope: IntegrationOutcomeEnvelope = {
        status: "error",
        action,
        summary: INTEGRATION_SUMMARY.requestRefused,
        detail: undefined
      };
      return { data: envelope as unknown as Record<string, unknown> };
    }

    const credentialEnvelope = await repository.loadCredentialEnvelope(scopedDb as never, conn.id);
    const secret = credentialEnvelope
      ? (deps.cipher.decryptJson(deps.cipher.parseEnvelope(credentialEnvelope)).secret as string)
      : null;
    const outcome = tool.invoke
      ? await invokeOpenApiTool(
          conn.baseUrl ?? conn.url,
          tool.invoke,
          input,
          secret,
          conn.credentialPlacement
        )
      : await callMcpTool(conn.url, secret, conn.credentialPlacement, tool.name, input);

    // #2175 Task 4: the budget counts what the service actually sent, before this cap trims it —
    // that is the traffic cost being controlled, not what the model ends up seeing.
    const capped = capChars(outcome.data, INTEGRATION_RESPONSE_CHAR_CAP);
    budget.recordChars(budgetScope, capped.rawChars);
    const cappedData = capped.truncated
      ? ({ ...outcome.data, result: capped.detail, truncated: true } as Record<string, unknown>)
      : outcome.data;

    const envelope: IntegrationOutcomeEnvelope = outcome.ok
      ? {
          status: "ok",
          action,
          summary: capped.truncated
            ? INTEGRATION_SUMMARY.truncated
            : action === "read"
              ? INTEGRATION_SUMMARY.readOk
              : INTEGRATION_SUMMARY.performedOk,
          detail: cappedData
        }
      : {
          status: "error",
          action,
          summary: INTEGRATION_SUMMARY.callFailed,
          detail: cappedData
        };
    memory.record(scope, conn.id, key, {
      ok: outcome.ok,
      action,
      summary: envelope.summary,
      detail: envelope.detail
    });
    return { data: envelope as unknown as Record<string, unknown> };
  };

  return {
    name: `${slug}.${tool.name}`,
    description: tool.description,
    permissionId: `integrations.${conn.id}`,
    risk: "outbound",
    executionPolicy: "auto",
    isExternal: true,
    externalContent: true,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    execute
  };
}

function buildSyntheticModule(
  conn: ConnectionRow,
  slug: string,
  tools: readonly ModuleAssistantToolManifest[]
): MossModuleManifest {
  return {
    id: `integration-${slug}`,
    name: conn.name,
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true, supportsUserDisable: false },
    assistantTools: tools
  };
}
