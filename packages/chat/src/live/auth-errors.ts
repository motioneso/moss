import type { AcpProviderKind } from "@moss/acp";

export const CODEX_SIGN_IN_REQUIRED_MESSAGE =
  "Codex is not signed in for this account. Sign-in is currently available only to administrators in Settings, Assistant & AI, using this same Moss account.";

const SIGN_IN_EXPIRED_MESSAGES = {
  anthropic:
    "The Claude sign-in has expired; an admin can log it in again under Settings, Assistant & AI",
  google:
    "The Google sign-in has expired; an admin can log it in again under Settings, Assistant & AI",
  opencode:
    "The OpenCode sign-in has expired; an admin can log it in again under Settings, Assistant & AI"
} as const;

const AUTH_FAILURE_MESSAGES = new Set([
  CODEX_SIGN_IN_REQUIRED_MESSAGE,
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
