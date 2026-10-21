import type { AiProviderConfigDto, ApiKeyChatReadinessStatus } from "@moss/shared";

/** #3410: API-key rows that can drive chat show a readiness line on their card. */
export function showsChatReadiness(
  provider: Pick<AiProviderConfigDto, "authMethod" | "providerKind">
): boolean {
  return (
    provider.authMethod === "api_key" &&
    (provider.providerKind === "anthropic" || provider.providerKind === "openai-compatible")
  );
}

/** The card's status line for an API-key chat row; null when chat is ready. */
export function describeChatReadiness(status: ApiKeyChatReadinessStatus): string | null {
  switch (status) {
    case "ready":
      return null;
    case "rejected_key":
      return "The provider rejected the API key";
    case "unreachable":
      return "Could not reach the provider";
    case "needs_key":
      return "No API key is saved";
    case "agent_missing":
      return "The chat program for this provider is not installed";
    case "runner_unavailable":
      return "The sign-in helper is not running";
  }
}
