import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, SharesRepository, createDatabase, type MossDatabase } from "@moss/db";
import { TasksRepository } from "@moss/tasks";
import type { TaskSuggestionMetadataV1 } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { seedTaskData, userAContext, userBContext, workerDataContext } from "./tasks-helpers.js";

describe("Tasks module M1 — manage-share create() cross-owner regression (#1490)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: TasksRepository;
  let sharesRepository: SharesRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedTaskData();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new TasksRepository();
    sharesRepository = new SharesRepository();
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  it("does not let a manage-share grantee's create() cross-owner-update the owner's row (#1490)", async () => {
    const resurfaceMetadata: TaskSuggestionMetadataV1 = {
      version: 1,
      category: "needs_action",
      sourceLabel: "Test",
      sourceHref: null,
      cacheMessageId: null,
      subjectSignature: "sig-collide-2",
      computedAt: new Date().toISOString(),
      resurfaceReason: "due_tomorrow"
    };

    const ownedByA = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, {
        title: "A's archived synced item",
        source: "sync",
        externalKey: "sync:collide-2",
        status: "archived"
      })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      sharesRepository.grant(db, {
        resourceType: "task",
        resourceId: ownedByA.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "manage"
      })
    );

    // B's create() carries exactly the shape that would trigger the archived->suggested resurface
    // UPDATE branch (repository.ts:219-241) if `existing` matched A's row — a `manage` share would
    // pass tasks_update's RLS check, so the only thing standing between this call and a cross-owner
    // UPDATE is the probe at repository.ts:216 staying owner-scoped despite RLS being owner-or-share.
    const createdByB = await dataContext.withDataContext(userBContext(), (db) =>
      repository.create(db, {
        title: "B's own item",
        source: "sync",
        externalKey: "sync:collide-2",
        status: "suggested",
        suggestionMetadata: resurfaceMetadata
      })
    );

    expect(createdByB.id).not.toBe(ownedByA.id);
    expect(createdByB.owner_user_id).toBe(ids.userB);

    const untouchedA = await dataContext.withDataContext(userAContext(), (db) =>
      repository.getById(db, ownedByA.id)
    );
    expect(untouchedA?.title).toBe(ownedByA.title);
    expect(untouchedA?.status).toBe(ownedByA.status);
    expect(untouchedA?.suggestion_metadata).toEqual(ownedByA.suggestion_metadata);
    expect(untouchedA?.updated_at).toEqual(ownedByA.updated_at);
  });

  it("holds the cross-owner create() probe for a jarvis_worker_runtime-backed repository instance too (#1490)", async () => {
    const worker = workerDataContext();
    try {
      const ownedByA = await dataContext.withDataContext(userAContext(), (db) =>
        repository.create(db, {
          title: "A's worker-path synced item",
          source: "sync",
          externalKey: "sync:collide-3"
        })
      );
      await dataContext.withDataContext(userAContext(), (db) =>
        sharesRepository.grant(db, {
          resourceType: "task",
          resourceId: ownedByA.id,
          ownerUserId: ids.userA,
          granteeUserId: ids.userB,
          level: "manage"
        })
      );

      const createdByB = await worker.dataContext.withDataContext(userBContext(), (db) =>
        repository.create(db, {
          title: "B's own item via worker role",
          source: "sync",
          externalKey: "sync:collide-3"
        })
      );

      expect(createdByB.id).not.toBe(ownedByA.id);
      expect(createdByB.owner_user_id).toBe(ids.userB);

      await expect(repository.create({} as never, { title: "unset context" })).rejects.toThrow(
        "Repository access requires withDataContext"
      );
    } finally {
      await worker.close();
    }
  });
});
