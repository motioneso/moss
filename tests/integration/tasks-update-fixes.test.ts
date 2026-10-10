import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { TaskListsRepository, TasksRepository } from "@moss/tasks";
import { connectionStrings, resetFoundationDatabase } from "./test-database.js";
import { seedTaskData, userAContext } from "./tasks-helpers.js";

describe("Tasks update: recurrence edits and parent list moves", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: TasksRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedTaskData();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new TasksRepository();
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  it("moving a parent task moves its subtasks and drops their foreign tags", async () => {
    const listsRepo = new TaskListsRepository();
    const listA = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreate(db, "A2")
    );
    const listB = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreate(db, "B2")
    );
    const tagA = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.createTag(db, listA.id, "child-only-A")
    );
    const parent = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "parent", listId: listA.id })
    );
    const child = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "child", listId: listA.id, parentTaskId: parent.id })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.assignTag(db, child.id, tagA.id)
    );

    await dataContext.withDataContext(userAContext(), (db) =>
      repository.update(db, parent.id, { listId: listB.id })
    );

    const movedChild = await dataContext.withDataContext(userAContext(), (db) =>
      repository.getById(db, child.id)
    );
    expect(movedChild?.list_id).toBe(listB.id);
    const childTags = await dataContext.withDataContext(userAContext(), (db) =>
      repository.getTagsForTask(db, child.id)
    );
    expect(childTags).toHaveLength(0);
  });

  it("saving a parent with its list unchanged leaves subtasks and their tags alone", async () => {
    const listsRepo = new TaskListsRepository();
    const listA = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreate(db, "A3")
    );
    const listB = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreate(db, "B3")
    );
    const tagB = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.createTag(db, listB.id, "child-only-B")
    );
    const parent = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "parent", listId: listA.id })
    );
    const child = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "child", listId: listB.id, parentTaskId: parent.id })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.assignTag(db, child.id, tagB.id)
    );

    await dataContext.withDataContext(userAContext(), (db) =>
      repository.update(db, parent.id, { title: "parent renamed", listId: listA.id })
    );

    const keptChild = await dataContext.withDataContext(userAContext(), (db) =>
      repository.getById(db, child.id)
    );
    expect(keptChild?.list_id).toBe(listB.id);
    expect(keptChild?.updated_at).toEqual(child.updated_at);
    const childTags = await dataContext.withDataContext(userAContext(), (db) =>
      repository.getTagsForTask(db, child.id)
    );
    expect(childTags).toHaveLength(1);
  });

  it("update persists a changed recurrence, keeps the series, and clears it with null", async () => {
    const task = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, {
        title: "repeating",
        recurrence: { freq: "daily", interval: 1, occurrence_date: "2026-06-08" }
      })
    );

    const changed = await dataContext.withDataContext(userAContext(), (db) =>
      repository.update(db, task.id, {
        recurrence: { freq: "weekly", interval: 2, occurrence_date: "2026-06-08" }
      })
    );
    expect(changed?.recurrence).toMatchObject({ freq: "weekly", interval: 2 });
    expect(changed?.recurrence_series_id).toBe(task.recurrence_series_id);

    const cleared = await dataContext.withDataContext(userAContext(), (db) =>
      repository.update(db, task.id, { recurrence: null })
    );
    expect(cleared?.recurrence).toBeNull();
    expect(cleared?.recurrence_series_id).toBeNull();

    const added = await dataContext.withDataContext(userAContext(), (db) =>
      repository.update(db, task.id, {
        recurrence: { freq: "monthly", interval: 1, occurrence_date: "2026-06-08" }
      })
    );
    expect(added?.recurrence).toMatchObject({ freq: "monthly" });
    expect(added?.recurrence_series_id).not.toBeNull();
  });
});
