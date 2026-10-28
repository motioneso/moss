import { randomUUID } from "node:crypto";

import { createDatabase, DataContextRunner, type ManagedSourceKey } from "@moss/db";
import { MeetingRecordsRepository } from "@moss/meetings";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ManagedSourceLifecycle,
  ManagedSourceFencedError,
  ManagedSourceUnavailableError,
  assertManagedSourceAdmission,
  assertManagedCleanupAdmission,
  type ManagedSourceAdmission
} from "@moss/notes";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { collectManagedNotesExportSection } from "@moss/notes";

const appDb = createDatabase({ connectionString: connectionStrings.app });
const workerDb = createDatabase({ connectionString: connectionStrings.worker });
const inspection = createDatabase({ connectionString: connectionStrings.bootstrap });
const appRunner = new DataContextRunner(appDb);
const workerRunner = new DataContextRunner(workerDb);
const records = new MeetingRecordsRepository();
const owner = { actorUserId: ids.userA };
const other = { actorUserId: ids.userB };
const authority = {
  async assertExists(db: Parameters<MeetingRecordsRepository["get"]>[0], source: ManagedSourceKey) {
    if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId))) {
      throw new ManagedSourceUnavailableError();
    }
  }
};
const lifecycle = new ManagedSourceLifecycle(appRunner, authority);

async function recording(): Promise<ManagedSourceKey> {
  const result = await appRunner.withDataContext(owner, (db) =>
    records.create(db, { requestKey: randomUUID(), title: "Synthetic lifecycle recording" })
  );
  return { ownerUserId: ids.userA, sourceModuleId: "meetings", sourceId: result.meeting.id };
}

beforeAll(resetFoundationDatabase);
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy(), inspection.destroy()]);
});

describe("managed source lifecycle admission", () => {
  it.each(["app", "worker"] as const)(
    "admits genuine %s owner authority and stable registration",
    async (role) => {
      const service = new ManagedSourceLifecycle(
        role === "app" ? appRunner : workerRunner,
        authority
      );
      const source = await recording();
      const snapshot = await service.registerSource(owner, source);
      expect(await service.registerSource(owner, source)).toEqual(snapshot);
      expect(snapshot.sources).toEqual([{ source, generation: 0 }]);
      await service.withPublication(owner, snapshot, async (db, admission) => {
        assertManagedSourceAdmission(db, admission);
        expect(admission.sources).toEqual(snapshot.sources);
      });
    }
  );

  it("rejects absent and inaccessible sources without recreating authority", async () => {
    const source = await recording();
    await expect(lifecycle.registerSource(other, source)).rejects.toThrow(
      ManagedSourceUnavailableError
    );
    await expect(
      lifecycle.registerSource(
        { actorUserId: ids.adminUser },
        {
          ...source,
          ownerUserId: ids.adminUser
        }
      )
    ).rejects.toThrow(ManagedSourceUnavailableError);
    await expect(
      lifecycle.registerSource(owner, {
        ...source,
        sourceId: randomUUID()
      })
    ).rejects.toThrow(ManagedSourceUnavailableError);
    const snapshot = await lifecycle.registerSource(owner, source);
    await appRunner.withDataContext(owner, (db) => records.remove(db, source.sourceId));
    await expect(lifecycle.withPublication(owner, snapshot, async () => true)).rejects.toThrow(
      ManagedSourceUnavailableError
    );
    await expect(lifecycle.registerSource(owner, source)).rejects.toThrow(
      ManagedSourceUnavailableError
    );
  });

  it("expires the admission before returning from its callback, even within the same transaction", async () => {
    const snapshot = await lifecycle.registerSource(owner, await recording());
    await appRunner.withDataContext(owner, async (db) => {
      const retained = await lifecycle.withPublicationScoped(
        db,
        snapshot,
        async (same, admission) => {
          expect(same).toBe(db);
          assertManagedSourceAdmission(same, admission);
          return admission;
        }
      );
      expect(() => assertManagedSourceAdmission(db, retained)).toThrow("current scoped admission");
    });
  });

  it("advances generations atomically and rejects stale publication", async () => {
    const source = await recording();
    const old = await lifecycle.registerSource(owner, source);
    await expect(
      lifecycle.advanceSource(owner, old, async () => {
        throw new Error("semantic update failed");
      })
    ).rejects.toThrow("semantic update failed");
    expect(await lifecycle.registerSource(owner, source)).toEqual(old);
    const next = await lifecycle.advanceSource(owner, old, async (_, snapshot) => snapshot);
    expect(next.sources[0]!.generation).toBe(old.sources[0]!.generation + 1);
    await expect(lifecycle.withPublication(owner, old, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
    await lifecycle.withPublication(owner, next, async (db, admission) =>
      assertManagedSourceAdmission(db, admission)
    );
  });

  it.each(["actor", "source"] as const)(
    "waits for admitted publication before %s fencing",
    async (boundary) => {
      // A separate actor is needed for the account-fence variant, which is permanent.
      const access = { actorUserId: boundary === "actor" ? ids.userB : ids.userA };
      const result = await appRunner.withDataContext(access, (db) =>
        records.create(db, { requestKey: randomUUID(), title: "Held lifecycle publication" })
      );
      const source = {
        ownerUserId: access.actorUserId,
        sourceModuleId: "meetings",
        sourceId: result.meeting.id
      };
      const snapshot = await lifecycle.registerSource(access, source);
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const publishing = lifecycle.withPublication(access, snapshot, async () => {
        entered();
        await held;
      });
      await ready;
      let completed = false;
      const fencing = (
        boundary === "actor" ? lifecycle.fenceActor(access) : lifecycle.fenceSource(access, source)
      ).then((result) => {
        completed = true;
        return result;
      });
      try {
        await expect
          .poll(
            async () => {
              if (completed) return "fenced-before-publication";
              const result = await sql<{ waiting: boolean }>`select exists (
          select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
          where l.locktype='advisory' and not l.granted and a.datname=current_database()
        ) as waiting`.execute(inspection);
              return result.rows[0]!.waiting ? "waiting" : "starting";
            },
            { timeout: 5000, interval: 20 }
          )
          .toBe("waiting");
      } finally {
        release();
        await publishing;
        await fencing;
      }
      await expect(lifecycle.withPublication(access, snapshot, async () => true)).rejects.toThrow(
        ManagedSourceFencedError
      );
      await expect(lifecycle.registerSource(access, source)).rejects.toThrow(
        ManagedSourceFencedError
      );
    }
  );

  it("persists one cleanup operation, rejects forged revisions and seals only complete cleanup", async () => {
    const source = await recording();
    const snapshot = await lifecycle.registerSource(owner, source);
    const operation = await lifecycle.fenceSource(owner, source);
    expect(operation.state).toBe("deleting");
    expect(await lifecycle.fenceSource(owner, source)).toEqual(operation);
    await expect(
      lifecycle.withCleanup(owner, { ...operation, operationId: randomUUID() }, async () => true)
    ).rejects.toThrow(ManagedSourceFencedError);
    await expect(
      lifecycle.withCleanup(
        owner,
        { ...operation, generation: operation.generation + 1 },
        async () => true
      )
    ).rejects.toThrow(ManagedSourceFencedError);
    await expect(lifecycle.withCleanup(other, operation, async () => true)).rejects.toThrow(
      ManagedSourceUnavailableError
    );
    await lifecycle.withCleanup(owner, operation, async (db, admission) => {
      assertManagedCleanupAdmission(db, admission);
      expect(admission.operation).toEqual(operation);
      // @ts-expect-error Cleanup must never authorize ordinary publication.
      expect(() => assertManagedSourceAdmission(db, admission)).toThrow("current scoped admission");
    });
    await expect(
      lifecycle.sealDeletion(owner, operation, async () => {
        throw new Error("unresolved receipt");
      })
    ).rejects.toThrow("unresolved receipt");
    expect((await lifecycle.fenceSource(owner, source)).state).toBe("deleting");
    const sealed = await lifecycle.sealDeletion(owner, operation, async () => undefined);
    expect(sealed.state).toBe("sealed");
    expect(
      await lifecycle.sealDeletion(owner, sealed, async () => {
        throw new Error("already sealed");
      })
    ).toEqual(sealed);
    await expect(lifecycle.withCleanup(owner, operation, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
    await expect(lifecycle.withPublication(owner, snapshot, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
  });

  it("rejects a different scoped transaction's publication capability", async () => {
    const snapshot = await lifecycle.registerSource(owner, await recording());
    let current!: ManagedSourceAdmission;
    await lifecycle.withPublication(owner, snapshot, async (_, admission) => {
      current = admission;
      await appRunner.withDataContext(owner, async (otherDb) => {
        expect(() => assertManagedSourceAdmission(otherDb, current)).toThrow(
          "current scoped admission"
        );
      });
    });
  });

  it("invalidates a combined note snapshot when one represented source advances", async () => {
    const first = await lifecycle.registerSource(owner, await recording());
    const second = await lifecycle.registerSource(owner, await recording());
    const combined = { ...first, sources: [...first.sources, ...second.sources] };
    await lifecycle.withPublication(owner, combined, async () => undefined);
    await lifecycle.advanceSource(owner, first, async () => undefined);
    await expect(lifecycle.withPublication(owner, combined, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
    await lifecycle.withPublication(owner, second, async () => undefined);
  });

  it.each(["app", "worker"] as const)(
    "keeps lifecycle rows owner-only for %s users and administrators",
    async (role) => {
      const runner = role === "app" ? appRunner : workerRunner;
      const source = await recording();
      const before = await lifecycle.registerSource(owner, source);
      for (const actorUserId of [ids.userB, ids.adminUser]) {
        await runner.withDataContext({ actorUserId }, async (db) => {
          const actors = await sql`select owner_user_id from app.notes_managed_actors
          where owner_user_id=${ids.userA}::uuid`.execute(db.db);
          const sources = await sql`select source_id from app.notes_managed_sources
          where owner_user_id=${ids.userA}::uuid`.execute(db.db);
          expect(actors.rows).toEqual([]);
          expect(sources.rows).toEqual([]);
          const changed = await sql`update app.notes_managed_sources set generation=generation+1
          where owner_user_id=${ids.userA}::uuid and source_id=${source.sourceId}::uuid
          returning source_id`.execute(db.db);
          expect(changed.rows).toEqual([]);
          const removed = await sql`delete from app.notes_managed_actors
          where owner_user_id=${ids.userA}::uuid returning owner_user_id`.execute(db.db);
          expect(removed.rows).toEqual([]);
        });
        await expect(
          runner.withDataContext({ actorUserId }, (db) =>
            sql`
        insert into app.notes_managed_sources(owner_user_id,source_module_id,source_id)
        values(${ids.userA}::uuid,'meetings',${randomUUID()}::uuid)
      `.execute(db.db)
          )
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect(await lifecycle.registerSource(owner, source)).toEqual(before);
    }
  );

  it("waits for source cleanup before account fencing and then supersedes it", async () => {
    const access = { actorUserId: ids.userC };
    const result = await appRunner.withDataContext(access, (db) =>
      records.create(db, {
        requestKey: randomUUID(),
        title: "Account cleanup supersession"
      })
    );
    const source = {
      ownerUserId: ids.userC,
      sourceModuleId: "meetings",
      sourceId: result.meeting.id
    };
    await lifecycle.registerSource(access, source);
    const sourceOperation = await lifecycle.fenceSource(access, source);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cleaning = lifecycle.withCleanup(access, sourceOperation, async (db, admission) => {
      assertManagedCleanupAdmission(db, admission);
      entered();
      await held;
    });
    await ready;
    let completed = false;
    const fencing = lifecycle.fenceActor(access).then((operation) => {
      completed = true;
      return operation;
    });
    try {
      await expect
        .poll(
          async () => {
            if (completed) return "fenced-before-cleanup";
            const result = await sql<{ waiting: boolean }>`select exists (
          select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
          where l.locktype='advisory' and not l.granted and a.datname=current_database()
        ) as waiting`.execute(inspection);
            return result.rows[0]!.waiting ? "waiting" : "starting";
          },
          { timeout: 5000, interval: 20 }
        )
        .toBe("waiting");
    } finally {
      release();
      await cleaning;
      await fencing;
    }
    const accountOperation = await fencing;
    expect(await lifecycle.fenceActor(access)).toEqual(accountOperation);
    await expect(lifecycle.withCleanup(access, sourceOperation, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
    await lifecycle.withCleanup(access, accountOperation, async (db, admission) => {
      assertManagedCleanupAdmission(db, admission);
    });
    await lifecycle.sealDeletion(access, accountOperation, async () => undefined);
    await expect(lifecycle.withCleanup(access, accountOperation, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
  });

  it.each(["app", "worker"] as const)(
    "exports only the %s actor's lifecycle metadata",
    async (role) => {
      const runner = role === "app" ? appRunner : workerRunner;
      const source = await recording();
      await lifecycle.registerSource(owner, source);
      for (const actorUserId of [ids.userA, ids.userB, ids.adminUser]) {
        const section = await runner.withDataContext(
          { actorUserId },
          collectManagedNotesExportSection
        );
        expect(
          [...section.actors, ...section.sources].every((row) => row.ownerUserId === actorUserId)
        ).toBe(true);
        if (actorUserId === ids.userA) {
          expect(section.actors).toHaveLength(1);
          expect(section.sources.some((row) => row.sourceId === source.sourceId)).toBe(true);
        } else {
          expect(section.sources.some((row) => row.sourceId === source.sourceId)).toBe(false);
        }
      }
    }
  );

  it("cascades lifecycle metadata with an actually removed account and rejects late work", async () => {
    // This checks metadata FK behavior only; owning account/file cleanup is separate wiring.
    const access = { actorUserId: ids.userD };
    const result = await appRunner.withDataContext(access, (db) =>
      records.create(db, {
        requestKey: randomUUID(),
        title: "Metadata cascade fixture"
      })
    );
    const source = {
      ownerUserId: ids.userD,
      sourceModuleId: "meetings",
      sourceId: result.meeting.id
    };
    const snapshot = await lifecycle.registerSource(access, source);
    await sql`delete from app.users where id=${ids.userD}::uuid`.execute(inspection);
    const actors = await sql`select owner_user_id from app.notes_managed_actors
      where owner_user_id=${ids.userD}::uuid`.execute(inspection);
    const sources = await sql`select source_id from app.notes_managed_sources
      where owner_user_id=${ids.userD}::uuid`.execute(inspection);
    expect(actors.rows).toEqual([]);
    expect(sources.rows).toEqual([]);
    await expect(lifecycle.registerSource(access, source)).rejects.toThrow(
      ManagedSourceUnavailableError
    );
    await expect(lifecycle.withPublication(access, snapshot, async () => true)).rejects.toThrow(
      ManagedSourceFencedError
    );
  });
});
