import { expect, type Locator, type Page, type Request } from "@playwright/test";

/**
 * The signature a failed asset fetch leaves behind. The UAT stack serves hashed bundles over the
 * container network, so a chunk can fail to arrive at random; the app then renders its load error
 * instead of the page. The message differs by browser (#3821).
 */
const MODULE_LOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed/i;
/** Only a failed script request is a module that failed to arrive. */
const SCRIPT_REQUEST = /\.m?js(\?|$)/;

/** True when the collected page errors are a bundle that failed to arrive, not a broken build. */
export function isModuleLoadFailure(messages: readonly string[]): boolean {
  return messages.some((message) => MODULE_LOAD_FAILURE.test(message));
}

/**
 * Opens one UAT page and waits until the app finished its first render.
 *
 * A chunk fetch that failed at random is a transport failure, not a product failure (#3821), so
 * one bounded reload is allowed and the retry must render. Every other failure, and a second
 * failure of any kind, is thrown as before: a broken build is never retried away.
 */
export async function gotoUatPage(
  page: Page,
  url: string,
  ready: Locator,
  timeout = 30_000
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const pageErrors: string[] = [];
    const failedScripts: string[] = [];
    const onPageError = (error: Error) => pageErrors.push(error.message);
    const onFailedRequest = (request: Request) => {
      if (request.failure() && SCRIPT_REQUEST.test(new URL(request.url()).pathname))
        failedScripts.push(request.url());
    };
    page.on("pageerror", onPageError);
    page.on("requestfailed", onFailedRequest);
    try {
      await page.goto(url);
      await expect(ready).toBeVisible({ timeout });
      return;
    } catch (error) {
      const transient = isModuleLoadFailure(pageErrors) || failedScripts.length > 0;
      if (attempt > 0 || !transient) throw error;
    } finally {
      page.off("pageerror", onPageError);
      page.off("requestfailed", onFailedRequest);
    }
  }
}
