import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type ManagedSourceKey } from "@moss/db";
import { MeetingRecordsRepository } from "@moss/meetings";
import {
  ManagedSourceLifecycle,
  ManagedSourceFencedError,
  ManagedSourceUnavailableError,
  assertManagedSourceAdmission
} from "../../packages/notes/src/managed-source-lifecycle.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
const records = new MeetingRecordsRepository();
const fixtureRunner = new DataContextRunner(appDb);
const owner = { actorUserId: ids.userA };
beforeEach(resetFoundationDatabase);
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy()]);
});

describe("preparatory managed-source capture", () => {
  it.each(["app", "worker"] as const)(
    "captures owner generations without granting publication under %s",
    async (role) => {
      const runner = new DataContextRunner(role === "app" ? appDb : workerDb);
      const lifecycle = new ManagedSourceLifecycle(runner, {
        async assertExists(db, source) {
          if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId))) {
            throw new ManagedSourceUnavailableError();
          }
        }
      });
      const createSource = async (): Promise<ManagedSourceKey> => {
        const result = await fixtureRunner.withDataContext(owner, (db) =>
          records.create(db, {
            requestKey: randomUUID(),
            title: "Synthetic source capture"
          })
        );
        return { ownerUserId: ids.userA, sourceModuleId: "meetings", sourceId: result.meeting.id };
      };
      const first = await createSource();
      const second = await createSource();
      await runner.withDataContext(owner, async (db) => {
        await expect(lifecycle.captureSourcesScoped(db, [first])).rejects.toThrow(
          ManagedSourceFencedError
        );
        await expect(lifecycle.captureSourcesScoped(db, [])).rejects.toThrow(
          ManagedSourceUnavailableError
        );
      });
      const original = await lifecycle.registerSource(owner, first);
      await lifecycle.registerSource(owner, second);
      const captured = await runner.withDataContext(owner, async (db) => {
        const snapshot = await lifecycle.captureSourcesScoped(db, [second, first, second]);
        expect(snapshot.ownerUserId).toBe(ids.userA);
        expect(snapshot.sources).toEqual(
          [first, second]
            .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
            .map((source) => ({ source, generation: 0 }))
        );
        expect(() => {
          // @ts-expect-error A preparatory snapshot is not a publication capability.
          assertManagedSourceAdmission(db, snapshot);
        }).toThrow("current scoped admission");
        await expect(
          lifecycle.captureSourcesScoped(db, [{ ...first, ownerUserId: ids.userB }])
        ).rejects.toThrow(ManagedSourceUnavailableError);
        await expect(
          lifecycle.captureSourcesScoped(db, [{ ...first, sourceId: randomUUID() }])
        ).rejects.toThrow(ManagedSourceFencedError);
        return snapshot;
      });
      await lifecycle.advanceSource(owner, original, async () => undefined);
      let published = false;
      await expect(
        lifecycle.withPublication(owner, captured, async () => {
          published = true;
        })
      ).rejects.toThrow(ManagedSourceFencedError);
      expect(published).toBe(false);
      const current = await runner.withDataContext(owner, (db) =>
        lifecycle.captureSourcesScoped(db, [first])
      );
      expect(current.sources[0]?.generation).toBe(1);
      await fixtureRunner.withDataContext(owner, (db) => records.remove(db, first.sourceId));
      await expect(
        lifecycle.withPublication(owner, current, async () => {
          published = true;
        })
      ).rejects.toThrow(ManagedSourceUnavailableError);
      expect(published).toBe(false);
      await lifecycle.fenceSource(owner, second);
      await runner.withDataContext(owner, (db) =>
        expect(lifecycle.captureSourcesScoped(db, [second])).rejects.toThrow(
          ManagedSourceFencedError
        )
      );
      await lifecycle.fenceActor(owner);
      await runner.withDataContext(owner, (db) =>
        expect(lifecycle.captureSourcesScoped(db, [first])).rejects.toThrow(
          ManagedSourceFencedError
        )
      );
    }
  );
});
