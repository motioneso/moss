export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

export type BaseUrlProviderKind = "anthropic" | "openai-compatible";

/** A provider model id Moss accepts from discovery and on the spawn RPC. */
export const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@-]{1,200}$/;

/**
 * A provider row's address in the form callers append paths to: no trailing slash and no
 * trailing `/v1`. An empty stored value means the kind's public default.
 */
export function providerBaseUrl(
  kind: BaseUrlProviderKind,
  stored: string | null | undefined
): string {
  const trimmed = (stored ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/+$/, "");
  if (trimmed.length > 0) return trimmed;
  return kind === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL;
}

/** True when an address embeds a username or password, which would leak into argv and config. */
export function providerBaseUrlHasUserInfo(value: string): boolean {
  try {
    const { username, password } = new URL(value.trim());
    return username !== "" || password !== "";
  } catch {
    return false;
  }
}
