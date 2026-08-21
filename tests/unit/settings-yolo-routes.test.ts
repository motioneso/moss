import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { isYoloActiveForActor } from "../../packages/settings/src/yolo-routes.js";

function fakeScopedDb(instanceEnabled: boolean): DataContextDb {
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () => (instanceEnabled ? { value: { enabled: true } } : undefined)
        })
      })
    })
  };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

describe("isYoloActiveForActor", () => {
  it("is active only when the instance flag, allow, and enable are all true", async () => {
    const scopedDb = fakeScopedDb(true);
    const prefs = { get: async () => true };
    expect(await isYoloActiveForActor(scopedDb, prefs)).toBe(true);
  });

  it("is inactive when the instance flag is off, even if the user allowed and enabled it", async () => {
    const scopedDb = fakeScopedDb(false);
    const prefs = { get: async () => true };
    expect(await isYoloActiveForActor(scopedDb, prefs)).toBe(false);
  });

  it("is inactive when the user has not enabled it, even with the instance flag on", async () => {
    const scopedDb = fakeScopedDb(true);
    const prefs = { get: async (_db: DataContextDb, key: string) => key !== "yolo.enabled" };
    expect(await isYoloActiveForActor(scopedDb, prefs)).toBe(false);
  });
});
