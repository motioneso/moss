/**
 * #2689: the provider toolsets the CLI tools manifest publishes (spec 2026-09-25 section 3.3).
 *
 * A toolset is a provider's CLI plus its chat adapter, promoted or held back together. The CLI
 * entry's install recipe (binary, per-arch packages, self-update switch) stays in the image
 * catalog; the manifest only moves versions and lockfiles.
 */

import type { RpcProviderKind } from "@moss/chat/live";

export type CliToolsetId = RpcProviderKind;

export type CliToolRole = "cli" | "chat-adapter";

export interface CliToolsetPackage {
  readonly role: CliToolRole;
  readonly pkg: string;
}

export interface CliToolsetDefinition {
  readonly id: CliToolsetId;
  readonly packages: readonly CliToolsetPackage[];
  /** Set by a maintainer when a newer toolset needs install or flag logic older Moss lacks. */
  readonly minMossVersion?: string;
}

export const CLI_TOOLSETS: readonly CliToolsetDefinition[] = Object.freeze([
  {
    id: "anthropic",
    packages: [
      { role: "cli", pkg: "@anthropic-ai/claude-code" },
      { role: "chat-adapter", pkg: "@agentclientprotocol/claude-agent-acp" }
    ]
  },
  {
    id: "openai-compatible",
    packages: [
      { role: "cli", pkg: "@openai/codex" },
      { role: "chat-adapter", pkg: "@agentclientprotocol/codex-acp" }
    ]
  },
  {
    id: "google",
    packages: [{ role: "cli", pkg: "@google/gemini-cli" }]
  }
]);

/**
 * The source repository each package's npm provenance must name (spec section 4.3). A package
 * listed here that arrives with provenance from any other repository blocks its toolset.
 * Per-arch packages publish under the same name with an arch-suffixed version, so one entry
 * covers them. Packages that have never carried provenance are listed for the record.
 */
export const EXPECTED_PROVENANCE_REPOS: Readonly<Record<string, string>> = Object.freeze({
  "@openai/codex": "https://github.com/openai/codex",
  "@agentclientprotocol/claude-agent-acp":
    "https://github.com/agentclientprotocol/claude-agent-acp",
  "@agentclientprotocol/codex-acp": "https://github.com/agentclientprotocol/codex-acp",
  "@anthropic-ai/claude-code": "https://github.com/anthropics/claude-code",
  "@anthropic-ai/claude-agent-sdk": "https://github.com/anthropics/claude-agent-sdk-typescript",
  "@google/gemini-cli": "https://github.com/google-gemini/gemini-cli"
});
