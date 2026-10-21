import type { AcpProviderKind } from "@moss/acp";

export const CODEX_SIGN_IN_REQUIRED_MESSAGE =
  "Codex is not connected yet. An administrator connects it once for everyone under Settings, AI providers.";

export const API_KEY_REJECTED_MESSAGE =
  "The provider rejected the API key. An admin can check it under Settings, AI providers.";

export const API_KEY_UNREADABLE_MESSAGE =
  "The API key for this provider could not be read. An admin can enter it again under Settings, AI providers.";

const SIGN_IN_EXPIRED_MESSAGES = {
  anthropic:
    "The Claude sign-in has expired; an admin can log it in again under Settings, AI providers",
  google:
    "The Google sign-in has expired; an admin can log it in again under Settings, AI providers",
  opencode:
    "The OpenCode sign-in has expired; an admin can log it in again under Settings, AI providers"
} as const;

const AUTH_FAILURE_MESSAGES = new Set([
  CODEX_SIGN_IN_REQUIRED_MESSAGE,
  API_KEY_REJECTED_MESSAGE,
  API_KEY_UNREADABLE_MESSAGE,
  ...Object.values(SIGN_IN_EXPIRED_MESSAGES)
]);

export function authFailureMessage(kind: AcpProviderKind): string {
  if (kind === "openai") return CODEX_SIGN_IN_REQUIRED_MESSAGE;
  return SIGN_IN_EXPIRED_MESSAGES[kind];
}

/** Return only fixed provider-auth messages; arbitrary provider text stays private. */
export function knownAuthFailureMessage(message: string): string | undefined {
  return AUTH_FAILURE_MESSAGES.has(message) ? message : undefined;
}
