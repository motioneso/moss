import { join, resolve } from "node:path";
import type { BrowserContext } from "playwright-core";
import { exerciseBills } from "./finance-live-bills.js";
import { exerciseFlex } from "./finance-live-flex.js";
/** Shared page ownership and failure capture for the two planning acceptance flows. */
export async function exercisePlanning(
  context: BrowserContext,
  base: string,
  month: string,
  read: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  kind: "bills" | "flex",
  artifacts?: string
) {
  const page = await context.newPage();
  try {
    await (kind === "bills" ? exerciseBills : exerciseFlex)(page, base, month, read, artifacts);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-${kind}-debug.png`),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
