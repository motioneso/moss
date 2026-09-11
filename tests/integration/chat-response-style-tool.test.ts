import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { CHAT_SETTINGS_PREFERENCE_KEY } from "@moss/shared";
import {
  chatSetResponseStyleExecute,
  chatSetResponseStyleInputSchema
} from "../../packages/chat/src/response-style-tool.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

function toolCtx(actorUserId: string): ToolContext {
  return { actorUserId, requestId: "req:response-style-tool-test", chatSessionId: "" };
}

describe("chat.setResponseStyle tool", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const preferences = new PreferencesRepository();

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  it("sets response style to detailed and persists a revision", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:response-style-a" },
      (scopedDb) => chatSetResponseStyleExecute(scopedDb, { style: "detailed" }, toolCtx(ids.userA))
    );
    expect(result.data).toEqual({ style: "detailed" });

    const stored = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:response-style-a-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY)
    );
    expect(stored?.value).toEqual({ responseStyle: "detailed" });
    expect(stored?.revision).toBe(1);
  });

  it("bumps the revision on a second write and does not affect another user", async () => {
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:response-style-a2" },
      (scopedDb) => chatSetResponseStyleExecute(scopedDb, { style: "concise" }, toolCtx(ids.userA))
    );
    const stored = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:response-style-a2-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY)
    );
    expect(stored?.value).toEqual({ responseStyle: "concise" });
    expect(stored?.revision).toBe(2);

    const otherStored = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:response-style-b-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY)
    );
    expect(otherStored).toBeNull();
  });

  it("preserves the saved OpenCode model when changing response style", async () => {
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:response-style-opencode-seed" },
      (scopedDb) =>
        preferences.upsert(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY, {
          responseStyle: "balanced",
          openCodeModel: "muse-spark-1.3-free"
        })
    );
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:response-style-opencode" },
      (scopedDb) => chatSetResponseStyleExecute(scopedDb, { style: "detailed" }, toolCtx(ids.userB))
    );

    const stored = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:response-style-opencode-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY)
    );
    expect(stored?.value).toEqual({
      responseStyle: "detailed",
      openCodeModel: "muse-spark-1.3-free"
    });
  });

  it("declares the style enum on inputSchema so the gateway rejects anything outside it", () => {
    expect(chatSetResponseStyleInputSchema.properties.style.enum).toEqual([
      "concise",
      "balanced",
      "detailed"
    ]);
  });
});
