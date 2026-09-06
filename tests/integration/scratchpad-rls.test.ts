import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { sql, type Kysely } from "kysely";
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
  it("connects as the shared runtime role, not a superuser or a role that can skip row security", async () => {
    const identity = await sql<{ current_user: string }>`select current_user`.execute(appDb);
    expect(identity.rows[0]?.current_user).toBe("jarvis_app_runtime");

    const role = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `.execute(appDb);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("forces row security on app.scratchpads, so even the table owner obeys it", async () => {
    const table = await sql<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid = 'app.scratchpads'::regclass
    `.execute(appDb);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.relrowsecurity).toBe(true);
    expect(table.rows[0]?.relforcerowsecurity).toBe(true);
  });

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

  it("an instance admin gets nothing back from user A's scratchpad, and cannot write or delete it", async () => {
    // Admin power is configuration power only (see the project's hard invariants) - row security
    // applies to every actor, including someone with is_instance_admin set.
    const adminView = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(adminView).toMatchObject({ body: "", revision: 0 });

    const userAState = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );

    const writeResult = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test" },
      (scopedDb) =>
        repository.put(scopedDb, { body: "admin overwrite", revision: userAState.revision })
    );
    expect(writeResult.ok).toBe(false);

    const deleteResult = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test" },
      (scopedDb) =>
        sql`DELETE FROM app.scratchpads WHERE user_id = ${ids.userA}`.execute(scopedDb.db)
    );
    expect(Number(deleteResult.numAffectedRows ?? 0)).toBe(0);

    const userAAfter = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(userAAfter.body).toBe("user A's private note");
  });

  it("another user's delete affects zero rows, but the owner can delete their own scratchpad", async () => {
    const otherUsersDelete = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) =>
        sql`DELETE FROM app.scratchpads WHERE user_id = ${ids.userA}`.execute(scopedDb.db)
    );
    expect(Number(otherUsersDelete.numAffectedRows ?? 0)).toBe(0);

    const stillThere = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(stillThere.body).toBe("user A's private note");

    const ownDelete = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) =>
        sql`DELETE FROM app.scratchpads WHERE user_id = ${ids.userA}`.execute(scopedDb.db)
    );
    expect(Number(ownDelete.numAffectedRows ?? 0)).toBe(1);

    const afterOwnDelete = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repository.get(scopedDb)
    );
    expect(afterOwnDelete).toMatchObject({ body: "", revision: 0 });
  });
});
