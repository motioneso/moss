/**
 * #3057: presets for a "decision model" (the AI provider kind `system-one`).
 *
 * Jev through TypeSafe, Cloudflare's Clef and any self-hosted Jev-compatible service all answer
 * the same named questions. The address picks the dialect: a base URL on `api.cloudflare.com`
 * speaks Cloudflare's wrapped envelope, every other address speaks the standard System One API.
 */

/** Which wire dialect a decision-model address speaks. */
export type DecisionModelDialect = "standard" | "cloudflare";

/** The only model ids Cloudflare accepts for the decision-model endpoint. */
export const CLOUDFLARE_DECISION_MODELS = ["clef", "clef-flash"] as const;

export type CloudflareDecisionModel = (typeof CLOUDFLARE_DECISION_MODELS)[number];

const CLOUDFLARE_DECISION_HOST = "api.cloudflare.com";
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const CLOUDFLARE_ACCOUNT_PATH_PATTERN = /^\/client\/v4\/accounts\/[0-9a-f]{32}\/ai$/;

/**
 * The dialect is chosen by host only. A blank, unparseable, or any non-Cloudflare address is the
 * standard dialect, so a host that merely contains the word "cloudflare" is never misrouted.
 */
export function decisionModelDialect(baseUrl: string | null | undefined): DecisionModelDialect {
  if (!baseUrl) return "standard";
  try {
    return new URL(baseUrl).host === CLOUDFLARE_DECISION_HOST ? "cloudflare" : "standard";
  } catch {
    return "standard";
  }
}

/** A Cloudflare account id is exactly 32 lowercase hex characters; it becomes a URL path segment. */
export function isCloudflareAccountId(value: string): boolean {
  return CLOUDFLARE_ACCOUNT_ID_PATTERN.test(value);
}

/** Build the stored address for a Cloudflare decision model. Throws on a malformed account id. */
export function cloudflareDecisionBaseUrl(accountId: string): string {
  if (!isCloudflareAccountId(accountId)) {
    throw new Error("Cloudflare account ID must be 32 lowercase hex characters.");
  }
  return `https://${CLOUDFLARE_DECISION_HOST}/client/v4/accounts/${accountId}/ai`;
}

/**
 * The exact stored shape of a Cloudflare decision-model address. Server validation uses this so a
 * hostile account string cannot steer the request to another host or path.
 */
export function isCloudflareDecisionBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.host === CLOUDFLARE_DECISION_HOST &&
      url.search === "" &&
      url.hash === "" &&
      CLOUDFLARE_ACCOUNT_PATH_PATTERN.test(url.pathname)
    );
  } catch {
    return false;
  }
}
