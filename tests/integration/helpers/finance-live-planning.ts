import { exerciseLegacyTargetRepair } from "./finance-live-target-repair.js";
import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";
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
  artifacts?: string,
  legacy?: { db: Kysely<MossDatabase>; actorUserId: string }
) {
  const page = await context.newPage();
  try {
    if (kind === "bills") await exerciseBills(page, base, month, read, artifacts);
    else
      await exerciseFlex(
        page,
        base,
        month,
        read,
        artifacts,
        legacy
          ? () =>
              exerciseLegacyTargetRepair(
                page,
                legacy.db,
                legacy.actorUserId,
                month,
                read,
                artifacts
              )
          : undefined
      );
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
