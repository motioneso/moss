import type { AiAuthMethod, AiProviderKind } from "@moss/shared";

export const PROVIDER_CATALOG: readonly {
  readonly label: string;
  readonly kind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
  readonly acpAgentId?: string;
}[] = [
  { label: "Anthropic", kind: "anthropic", authMethod: "cli" },
  { label: "Codex", kind: "openai-compatible", authMethod: "cli", acpAgentId: "codex-acp" },
  { label: "OpenCode", kind: "openai-compatible", authMethod: "cli", acpAgentId: "opencode" },
  { label: "Google", kind: "google", authMethod: "cli" },
  { label: "Mistral", kind: "openai-compatible", authMethod: "api_key" },
  { label: "Local (Ollama)", kind: "ollama", authMethod: "api_key" },
  { label: "OpenAI-compatible", kind: "openai-compatible", authMethod: "api_key" },
  { label: "System One (TypeSafe)", kind: "system-one", authMethod: "api_key" },
  { label: "Custom", kind: "custom", authMethod: "api_key" }
];

export const OPENAI_COMPATIBLE_CLI_AGENTS = [
  { id: "codex-acp", label: "Codex" },
  { id: "opencode", label: "OpenCode" }
] as const;
