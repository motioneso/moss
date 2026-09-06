import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import type { ToolContext } from "@moss/module-sdk";
import { scratchpadAppendExecute, scratchpadReadExecute } from "@moss/scratchpad";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2236 slice 1: the assistant tools' real read/append behavior against a database, not just
// their input validation. Covers the case the reviewer flagged as missing: appending to an
// already-full pad must come back as the tool's own friendly error, not a thrown exception.

const fakeCtx = {} as ToolContext;

describe("scratchpad assistant tools", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  it("read on an empty pad, then append, then read again shows the new line", async () => {
    const empty = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => scratchpadReadExecute(scopedDb, {}, fakeCtx)
    );
    expect(empty.data).toMatchObject({ body: "", characterCount: 0, revision: 0 });

    const appended = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => scratchpadAppendExecute(scopedDb, { text: "call the vet" }, fakeCtx)
    );
    expect(appended.data).toMatchObject({ appended: "call the vet" });

    const after = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => scratchpadReadExecute(scopedDb, {}, fakeCtx)
    );
    expect(after.data).toMatchObject({ body: "call the vet", characterCount: 12 });
  });

  it("appending to an already-full pad returns the friendly 'Scratchpad is full' error, not a thrown exception", async () => {
    await dataContext.withDataContext({ actorUserId: ids.userB, requestId: "test" }, (scopedDb) =>
      scopedDb.db
        .insertInto("app.scratchpads")
        .values({
          user_id: ids.userB,
          body: "a".repeat(64000),
          revision: 1,
          sync_to_notes: false,
          shortcut: "mod+shift+s",
          updated_at: new Date()
        })
        .execute()
    );

    const result = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) => scratchpadAppendExecute(scopedDb, { text: "one more line" }, fakeCtx)
    );
    expect(result.data).toMatchObject({ error: "Scratchpad is full" });
  });
});
