import type { CredentialPlacement, IntegrationDetail, IntegrationKind } from "@moss/shared";

import {
  effectiveEnabledTools,
  isGroupOptIn,
  willDeriveGroups,
  withDerivedGroups
} from "./curation.js";
import { OTHER_GROUP } from "./derive-groups.js";
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
  const state = {
    enabledGroups: row.enabledGroups,
    enabledTools: row.enabledTools,
    mutedTools: row.mutedTools
  };
  const enabled = effectiveEnabledTools(tools, state);
  const withGroups = withDerivedGroups(tools);
  const isDerivedOther = willDeriveGroups(tools);
  const groupNames = [...new Set(withGroups.map((t) => t.group))].sort((a, b) =>
    a === OTHER_GROUP ? 1 : b === OTHER_GROUP ? -1 : 0
  );
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
    tools: withGroups.map(({ invoke: _invoke, ...t }) => t),
    groups: groupNames.map((name) => ({
      name,
      toolCount: withGroups.filter((t) => t.group === name).length,
      // The derived Other bucket is never a group-level opt-in unit (see curation.ts), so
      // reporting it "enabled" from a stale/irrelevant enabledGroups entry would claim tools are
      // live that are not. #2175 comment 5515241034, blocking finding 3.
      enabled: isDerivedOther && name === OTHER_GROUP ? false : row.enabledGroups.includes(name)
    })),
    enabledGroups: row.enabledGroups,
    enabledTools: row.enabledTools,
    mutedTools: row.mutedTools,
    unsuppressedTools: row.unsuppressedTools,
    groupOptIn: isGroupOptIn(tools),
    specPasted: row.specPasted
  };
}

export function resolveOpenApiBase(spec: unknown, specUrl: string): string {
  const server = (spec as { servers?: { url?: unknown }[] } | null)?.servers?.[0]?.url;
  const base = new URL(typeof server === "string" && server ? server : "/", specUrl);
  return base.toString().replace(/\/+$/, "");
}
