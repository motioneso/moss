import { describe, expect, it } from "vitest";

import {
  dataContextBrand,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "../../packages/db/src/index.js";
import { createGateModeReader } from "../../packages/chat/src/live/classifier-gate-mode.js";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

/**
 * A data context whose scoped database holds one saved gate value and refuses every other table,
 * so a read of the review table or the classifier binding fails the test.
 */
function fakeDataContext(storedValue: string | undefined) {
  const tablesRead: string[] = [];
  const actors: string[] = [];
  const scopedDb = {
    [dataContextBrand]: true,
    db: {
      selectFrom: (table: string) => {
        tablesRead.push(table);
        if (table !== "app.instance_settings") {
          throw new Error(`gate mode reader read ${table}`);
        }
        return {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () =>
                storedValue === undefined ? undefined : { value: { value: storedValue } }
            })
          })
        };
      }
    }
  } as unknown as DataContextDb;
  const dataContext = {
    withDataContext: async <T>(
      context: AccessContext,
      work: (db: DataContextDb) => Promise<T>
    ): Promise<T> => {
      actors.push(context.actorUserId);
      return work(scopedDb);
    }
  } as unknown as Pick<DataContextRunner, "withDataContext">;
  return { dataContext, tablesRead, actors };
}

describe("createGateModeReader", () => {
  it("runs a saved on as on and never reads the review table or the classifier binding", async () => {
    const { dataContext, tablesRead, actors } = fakeDataContext("on");
    const read = createGateModeReader(dataContext, {});

    await expect(read(ACTOR_ID)).resolves.toBe("on");
    expect(tablesRead).toEqual(["app.instance_settings"]);
    expect(actors).toEqual([ACTOR_ID]);
  });

  it("runs an environment on as on when nothing is saved", async () => {
    const { dataContext } = fakeDataContext(undefined);
    const read = createGateModeReader(dataContext, { MOSS_CHAT_CLASSIFIER_GATE_MODE: "on" });

    await expect(read(ACTOR_ID)).resolves.toBe("on");
  });

  it("keeps a saved off ahead of an environment on", async () => {
    const { dataContext } = fakeDataContext("off");
    const read = createGateModeReader(dataContext, { MOSS_CHAT_CLASSIFIER_GATE_MODE: "on" });

    await expect(read(ACTOR_ID)).resolves.toBe("off");
  });

  it("returns a saved shadow unchanged, and off when nothing is set", async () => {
    await expect(
      createGateModeReader(fakeDataContext("shadow").dataContext, {})(ACTOR_ID)
    ).resolves.toBe("shadow");
    await expect(
      createGateModeReader(fakeDataContext(undefined).dataContext, {})(ACTOR_ID)
    ).resolves.toBe("off");
  });
});
