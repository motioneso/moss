import type { AiAuthMethod, AiProviderKind } from "@moss/shared";

/** #3057: which preset of the `system-one` decision-model provider a catalog entry adds. */
export type DecisionModelPreset = "typesafe" | "cloudflare" | "compatible";

/**
 * The example shown in a provider's endpoint and key fields. Each kind shows its own: an example
 * that names another company's address or key style sends the person hunting for the wrong thing.
 */
export const CREDENTIAL_EXAMPLES: Readonly<
  Record<AiProviderKind, { readonly baseUrl: string; readonly apiKey: string }>
> = {
  anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-…" },
  "openai-compatible": { baseUrl: "https://api.openai.com", apiKey: "sk-…" },
  google: { baseUrl: "https://generativelanguage.googleapis.com", apiKey: "AIza…" },
  ollama: { baseUrl: "http://localhost:11434", apiKey: "Any value" },
  custom: { baseUrl: "https://your-endpoint.example.com", apiKey: "Your API key" },
  "system-one": { baseUrl: "https://api.typesafe.ai", apiKey: "apikey_…" }
};

export const PROVIDER_CATALOG: readonly {
  readonly label: string;
  readonly kind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
  readonly acpAgentId?: string;
  readonly preset?: DecisionModelPreset;
}[] = [
  { label: "Anthropic", kind: "anthropic", authMethod: "cli" },
  { label: "Codex", kind: "openai-compatible", authMethod: "cli", acpAgentId: "codex-acp" },
  { label: "OpenCode", kind: "openai-compatible", authMethod: "cli", acpAgentId: "opencode" },
  { label: "Google", kind: "google", authMethod: "cli" },
  { label: "Mistral", kind: "openai-compatible", authMethod: "api_key" },
  { label: "Local (Ollama)", kind: "ollama", authMethod: "api_key" },
  { label: "OpenAI-compatible", kind: "openai-compatible", authMethod: "api_key" },
  { label: "Jev (TypeSafe)", kind: "system-one", authMethod: "api_key", preset: "typesafe" },
  { label: "Clef (Cloudflare)", kind: "system-one", authMethod: "api_key", preset: "cloudflare" },
  {
    label: "Any compatible service",
    kind: "system-one",
    authMethod: "api_key",
    preset: "compatible"
  },
  { label: "Custom", kind: "custom", authMethod: "api_key" }
];

export const OPENAI_COMPATIBLE_CLI_AGENTS = [
  { id: "codex-acp", label: "Codex" },
  { id: "opencode", label: "OpenCode" }
] as const;
