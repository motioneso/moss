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

export type ProviderGroup = "subscription" | "api-key" | "decision";

export const PROVIDER_GROUPS: readonly {
  readonly id: ProviderGroup;
  readonly label: string;
}[] = [
  { id: "subscription", label: "Sign in with a subscription" },
  { id: "api-key", label: "Use an API key" },
  { id: "decision", label: "Decision models" }
];

export type ProviderChoice = {
  readonly id: string;
  /** Also the default name of a provider added from this choice. */
  readonly label: string;
  readonly description: string;
  readonly group: ProviderGroup;
  readonly kind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
  readonly acpAgentId?: string;
  readonly preset?: DecisionModelPreset;
};

export const PROVIDER_CATALOG: readonly ProviderChoice[] = [
  {
    id: "claude",
    label: "Claude",
    description: "Use your Claude subscription.",
    group: "subscription",
    kind: "anthropic",
    authMethod: "cli"
  },
  {
    id: "codex",
    label: "Codex",
    description: "Use your ChatGPT subscription.",
    group: "subscription",
    kind: "openai-compatible",
    authMethod: "cli",
    acpAgentId: "codex-acp"
  },
  {
    id: "gemini",
    label: "Gemini",
    description: "Use your Google subscription.",
    group: "subscription",
    kind: "google",
    authMethod: "cli"
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Use the accounts set up in OpenCode.",
    group: "subscription",
    kind: "openai-compatible",
    authMethod: "cli",
    acpAgentId: "opencode"
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    description: "OpenAI, Mistral or any service with an OpenAI-style address.",
    group: "api-key",
    kind: "openai-compatible",
    authMethod: "api_key"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Pay per use with an Anthropic key.",
    group: "api-key",
    kind: "anthropic",
    authMethod: "api_key"
  },
  {
    id: "google",
    label: "Google",
    description: "Pay per use with a Google AI key.",
    group: "api-key",
    kind: "google",
    authMethod: "api_key"
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    description: "Run models on your own machine.",
    group: "api-key",
    kind: "ollama",
    authMethod: "api_key"
  },
  {
    id: "jev",
    label: "Jev",
    description: "Decision model hosted by TypeSafe.",
    group: "decision",
    kind: "system-one",
    authMethod: "api_key",
    preset: "typesafe"
  },
  {
    id: "clef",
    label: "Clef",
    description: "Decision model running on Cloudflare.",
    group: "decision",
    kind: "system-one",
    authMethod: "api_key",
    preset: "cloudflare"
  },
  {
    id: "compatible",
    label: "Any compatible service",
    description: "A decision model at an address you choose.",
    group: "decision",
    kind: "system-one",
    authMethod: "api_key",
    preset: "compatible"
  }
];

/** A subscription sign-in is stored per kind today, so a second one would share the first account. */
export const SUBSCRIPTION_TAKEN_NOTE =
  "Already connected. Remove it to sign in with another account.";

type ExistingProvider = {
  readonly authMethod: AiAuthMethod;
  readonly providerKind: AiProviderKind;
  readonly acpAgentId?: string | null;
  readonly displayName: string;
  readonly status?: string;
};

/** True when a subscription choice already has a provider. API key choices never do. */
export function subscriptionChoiceTaken(
  choice: ProviderChoice,
  providers: readonly ExistingProvider[]
): boolean {
  if (choice.group !== "subscription") return false;
  return providers.some(
    (provider) =>
      provider.status !== "revoked" &&
      provider.authMethod === "cli" &&
      provider.providerKind === choice.kind &&
      (provider.acpAgentId ?? undefined) === choice.acpAgentId
  );
}

/** The next free name: "Claude", then "Claude 2", "Claude 3". Case-insensitive. */
export function nextFreeName(label: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
  if (!taken.has(label.toLowerCase())) return label;
  for (let n = 2; ; n += 1) {
    const candidate = `${label} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
