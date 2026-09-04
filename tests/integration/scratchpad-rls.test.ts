import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import { ScratchpadRepository } from "@moss/scratchpad";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2236 slice 1: proves app.scratchpads is owner-only under row-level security - one user's
// scratchpad is invisible to, and unwritable by, every other user, even though every actor
// connects through the same jarvis_app_runtime role (RLS scopes by actor id, not by role).

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repository = new ScratchpadRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("app.scratchpads row-level security (#2236)", () => {
  it("a user reading an empty scratchpad gets revision 0 and empty body", async () => {
    const state = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(state).toMatchObject({ body: "", revision: 0 });
  });

  it("user A's scratchpad is invisible to user B", async () => {
    await dataContext.withDataContext({ actorUserId: ids.userA, requestId: "test" }, (scopedDb) =>
      repository.put(scopedDb, { body: "user A's private note", revision: 0 })
    );

    const userBView = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );

    expect(userBView).toMatchObject({ body: "", revision: 0 });
  });

  it("user B cannot update user A's scratchpad by guessing its revision", async () => {
    const userAState = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(userAState.revision).toBeGreaterThan(0);

    // RLS scopes the UPDATE's WHERE clause to user B's own (nonexistent) row, so this affects
    // zero rows and the repository reports it the same way it reports a genuine conflict.
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) => repository.put(scopedDb, { body: "hijacked", revision: userAState.revision })
    );
    expect(result.ok).toBe(false);

    const userAAfter = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(userAAfter.body).toBe("user A's private note");
  });

  it("user B appending does not touch user A's scratchpad", async () => {
    await dataContext.withDataContext({ actorUserId: ids.userB, requestId: "test" }, (scopedDb) =>
      repository.append(scopedDb, "user B's own line")
    );

    const userAAfter = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(userAAfter.body).toBe("user A's private note");

    const userBAfter = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(userBAfter.body).toBe("user B's own line");
  });
});
