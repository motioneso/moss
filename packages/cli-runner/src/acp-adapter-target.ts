import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { getAcpProviderRow, type AcpProviderKind } from "@moss/acp";

import { resolveToolsVolumeAdapterEntry, type ReleaseOverrides } from "./tools-volume-adapters.js";

/** What runs for one adapter spawn: node plus the row's pinned entry, or the provider binary. */
export interface AcpAdapterTarget {
  readonly command: string;
  readonly args: string[];
}

/** Node-spawnable adapter entries by provider kind, from the pinned registry packages. */
const ADAPTER_ENTRY_PACKAGES = {
  anthropic: "@agentclientprotocol/claude-agent-acp/dist/index.js",
  openai: "@agentclientprotocol/codex-acp/dist/index.js"
} as const;

/** Resolve the spawn target for a provider kind; unknown kinds are refused by the row lookup. */
export function defaultResolveAdapterTarget(
  kind: AcpProviderKind,
  toolsPrefix?: string,
  overrides?: ReleaseOverrides
): AcpAdapterTarget {
  getAcpProviderRow(kind);
  if (toolsPrefix && (kind === "anthropic" || kind === "openai")) {
    const installed = resolveToolsVolumeAdapterEntry(toolsPrefix, kind, overrides);
    if (installed) return { command: process.execPath, args: [installed] };
  }
  if (kind === "opencode") {
    // Pinned package launcher (postinstall places the platform binary there).
    const packageJson = createRequire(import.meta.url).resolve("opencode-ai/package.json");
    return { command: join(dirname(packageJson), "bin", "opencode.exe"), args: ["acp"] };
  }
  const entry = ADAPTER_ENTRY_PACKAGES[kind as keyof typeof ADAPTER_ENTRY_PACKAGES];
  if (!entry) throw new Error(`No adapter package installed for provider kind: ${kind}`);
  return {
    command: process.execPath,
    args: [createRequire(import.meta.url).resolve(entry)]
  };
}
