import type { CredentialPlacement, IntegrationDetail, IntegrationKind } from "@moss/shared";

import { effectiveEnabledTools, isGroupOptIn } from "./curation.js";
import { discoverMcpTools } from "./mcp-client.js";
import { convertOpenApiSpec, type DiscoveredTool } from "./openapi-convert.js";
import { fetchOpenApiSpec } from "./openapi-invoke.js";
import type { ConnectionRow } from "./repository.js";

export async function discoverTools(
  kind: IntegrationKind,
  url: string,
  secret: string | null,
  placement: CredentialPlacement | null
): Promise<DiscoveredTool[]> {
  if (kind === "mcp") return discoverMcpTools(url, secret, placement);
  return convertOpenApiSpec(await fetchOpenApiSpec(url, secret, placement));
}

export function toDetail(row: ConnectionRow, tools: readonly DiscoveredTool[]): IntegrationDetail {
  const state = { enabledGroups: row.enabledGroups, enabledTools: row.enabledTools, mutedTools: row.mutedTools };
  const enabled = effectiveEnabledTools(tools, state);
  const groupNames = [...new Set(tools.map((t) => t.group))];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    enabled: row.enabled,
    hasCredential: row.hasCredential,
    toolCount: tools.length,
    enabledToolCount: enabled.length,
    lastDiscoveryAt: row.lastDiscoveryAt ? row.lastDiscoveryAt.toISOString() : null,
    lastError: row.lastError,
    credentialPlacement: row.credentialPlacement,
    tools: tools.map(({ invoke: _invoke, ...t }) => t),
    groups: groupNames.map((name) => ({
      name,
      toolCount: tools.filter((t) => t.group === name).length,
      enabled: row.enabledGroups.includes(name)
    })),
    enabledGroups: row.enabledGroups,
    enabledTools: row.enabledTools,
    mutedTools: row.mutedTools,
    groupOptIn: isGroupOptIn(tools.length)
  };
}

export function resolveOpenApiBase(spec: unknown, specUrl: string): string {
  const server = (spec as { servers?: { url?: unknown }[] } | null)?.servers?.[0]?.url;
  const base = new URL(typeof server === "string" && server ? server : "/", specUrl);
  return base.toString().replace(/\/+$/, "");
}
