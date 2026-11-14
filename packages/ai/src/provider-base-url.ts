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

/**
 * The OpenAI-compatible API root: the address endpoint paths hang off. A bare host means the
 * standard `/v1` surface, so a stored value of either `https://host` or `https://host/v1`
 * yields exactly `https://host/v1`. Any other stored path is the caller's own API root and is
 * kept as written — `https://host/v1beta/openai` and `https://openrouter.ai/api/v1` must not
 * receive a second version segment (#3559).
 */
export function openAiCompatibleApiRoot(stored: string | null | undefined): string {
  const trimmed = (stored ?? "").trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return `${OPENAI_DEFAULT_BASE_URL}/v1`;
  return addressHasPath(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Whether the address names anything after its host. Tolerant on purpose: a stored value that
 * is not a parseable URL keeps whatever path text it has, so an odd inherited row behaves the
 * same before and after this rule.
 */
function addressHasPath(value: string): boolean {
  try {
    const { pathname } = new URL(value);
    return pathname !== "" && pathname !== "/";
  } catch {
    const withoutScheme = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
    const slash = withoutScheme.indexOf("/");
    return slash !== -1 && slash < withoutScheme.length - 1;
  }
}
