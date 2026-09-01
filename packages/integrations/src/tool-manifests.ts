import { randomUUID } from "node:crypto";

import type { AccessContext, DataContextRunner, JsonSecretCipher } from "@moss/db";
import type {
  ModuleAssistantToolManifest,
  MossModuleManifest,
  ToolExecute,
  ToolResult
} from "@moss/module-sdk";

import { effectiveEnabledTools } from "./curation.js";
import { callMcpTool } from "./mcp-client.js";
import type { DiscoveredTool } from "./openapi-convert.js";
import { invokeOpenApiTool } from "./openapi-invoke.js";
import { IntegrationsRepository, type ConnectionRow } from "./repository.js";

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

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
  const execute: ToolExecute = async (scopedDb, input): Promise<ToolResult> => {
    const envelope = await repository.loadCredentialEnvelope(scopedDb as never, conn.id);
    const secret = envelope
      ? (deps.cipher.decryptJson(deps.cipher.parseEnvelope(envelope)).secret as string)
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
    return { data: outcome.ok ? outcome.data : { error: true, ...outcome.data } };
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
