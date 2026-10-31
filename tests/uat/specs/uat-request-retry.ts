import type { APIResponse, Page } from "@playwright/test";

/** How long one retry may wait for the product's own throttle to clear. */
const MAX_RETRY_WAIT_MS = 60_000;
/** Attempts per request. The first call is the real one; the rest only outlast a throttle. */
const ATTEMPTS = 3;

/**
 * Posts one request to a route that carries Moss's per-peer rate limit.
 *
 * Companion and capture routes are throttled by peer address, and the product answers a throttle
 * with 429 and Retry-After. A real client waits and retries, so this does the same, bounded: a
 * throttle is not a product failure, but an exhausted budget still returns the 429 so the calling
 * spec's own status assertion decides the outcome (#3821).
 */
export async function postWithRateLimitRetry(
  page: Pick<Page, "request">,
  path: string,
  options: { data?: unknown; headers?: Record<string, string> } = {}
): Promise<APIResponse> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const response = await page.request.post(path, options);
    if (response.status() !== 429 || attempt === ATTEMPTS - 1) return response;
    await waitForRetry(response.headers()["retry-after"]);
  }
  throw new Error("unreachable: the last attempt returns its response");
}

/** Honors Retry-After in either documented form, bounded so a spec cannot hang on it. */
async function waitForRetry(header: string | undefined): Promise<void> {
  const seconds = header === undefined ? Number.NaN : Number(header);
  const until = header === undefined ? Number.NaN : Date.parse(header);
  const wait = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(until)
      ? until - Date.now()
      : 1000;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(MAX_RETRY_WAIT_MS, Math.max(1000, wait)))
  );
}
