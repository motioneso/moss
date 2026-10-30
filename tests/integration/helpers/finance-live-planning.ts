import { expect } from "vitest";
import { exerciseLegacyTargetRepair } from "./finance-live-target-repair.js";
import type { Kysely } from "kysely";
import { DataContextRunner, createModuleStorageRpc, type MossDatabase } from "@moss/db";
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
  let restoreBillFixture: (() => Promise<void>) | undefined;
  try {
    if (kind === "bills" && legacy) {
      const runner = new DataContextRunner(legacy.db);
      const query = (text: string, params: readonly unknown[] = []) =>
        runner.withDataContext({ actorUserId: legacy.actorUserId }, (scope) =>
          createModuleStorageRpc(scope, "finance").query(text, params)
        );
      const original = await query(
        "SELECT date::text AS day FROM app.finance_transactions WHERE id='synthetic-market'"
      );
      expect(original.rows).toHaveLength(1);
      restoreBillFixture = async () => {
        await query(
          "UPDATE app.finance_transactions SET date=$1::date WHERE id='synthetic-market'",
          [original.rows[0]!.day]
        );
      };
      // Disposable synthetic fixture only: put the already-posted expense across the month edge.
      await query(
        "UPDATE app.finance_transactions SET date=($1::date - 1) WHERE id='synthetic-market'",
        [`${month}-01`]
      );
    }
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
    await restoreBillFixture?.();
    await page.close();
  }
}
