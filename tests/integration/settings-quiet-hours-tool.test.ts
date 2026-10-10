import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { quietHoursSetExecute } from "../../packages/settings/src/quiet-hours-tool.js";
import { settingsUndoStack } from "../../packages/settings/src/undo-stack.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const QUIET_HOURS_PREFERENCE_KEY = "quiet-hours";

function toolCtx(actorUserId: string): ToolContext {
  return { actorUserId, requestId: "req:quiet-hours-tool-test", chatSessionId: "" };
}

describe("settings.quietHours.set tool", () => {
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

  it("sets enabled/start/end/timezone and returns the stored value", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:quiet-hours-a" },
      (scopedDb) =>
        quietHoursSetExecute(
          scopedDb,
          { enabled: true, start: "22:00", end: "07:00", timezone: "America/Denver" },
          toolCtx(ids.userA)
        )
    );
    expect(result.data).toEqual({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "America/Denver"
    });

    const stored = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:quiet-hours-a-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, QUIET_HOURS_PREFERENCE_KEY)
    );
    expect(stored?.value).toEqual({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "America/Denver"
    });
    expect(stored?.revision).toBe(1);
  });

  it("normalizes a blank timezone to null", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:quiet-hours-b" },
      (scopedDb) =>
        quietHoursSetExecute(
          scopedDb,
          { enabled: false, start: "23:00", end: "06:30", timezone: "  " },
          toolCtx(ids.userB)
        )
    );
    expect(result.data).toEqual({ enabled: false, start: "23:00", end: "06:30", timezone: null });
  });

  it("rejects a malformed start time", async () => {
    await expect(
      dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:quiet-hours-bad-start" },
        (scopedDb) =>
          quietHoursSetExecute(
            scopedDb,
            { enabled: true, start: "25:00", end: "07:00", timezone: null },
            toolCtx(ids.userA)
          )
      )
    ).rejects.toThrow();
  });

  it("rejects a malformed end time", async () => {
    await expect(
      dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:quiet-hours-bad-end" },
        (scopedDb) =>
          quietHoursSetExecute(
            scopedDb,
            { enabled: true, start: "22:00", end: "99:99", timezone: null },
            toolCtx(ids.userA)
          )
      )
    ).rejects.toThrow();
  });

  it("is a no-op when enabled/start/end/timezone already match: no revision bump, no undo entry", async () => {
    await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:quiet-hours-noop-seed" },
      (scopedDb) =>
        quietHoursSetExecute(
          scopedDb,
          { enabled: true, start: "22:00", end: "07:00", timezone: "America/Denver" },
          toolCtx(ids.adminUser)
        )
    );
    const before = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:quiet-hours-noop-before" },
      (scopedDb) => preferences.getWithRevision(scopedDb, QUIET_HOURS_PREFERENCE_KEY)
    );
    settingsUndoStack.clear(ids.adminUser, "");

    const result = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:quiet-hours-noop" },
      (scopedDb) =>
        quietHoursSetExecute(
          scopedDb,
          { enabled: true, start: "22:00", end: "07:00", timezone: "America/Denver" },
          toolCtx(ids.adminUser)
        )
    );
    expect(result.data).toEqual({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "America/Denver"
    });

    const after = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:quiet-hours-noop-after" },
      (scopedDb) => preferences.getWithRevision(scopedDb, QUIET_HOURS_PREFERENCE_KEY)
    );
    expect(after?.revision).toBe(before?.revision);
    expect(settingsUndoStack.pop(ids.adminUser, "")).toBeUndefined();
  });
  it("rejects an unknown timezone and an equal-time window without changing the stored value", async () => {
    const before = await readAs(ids.userA);
    for (const input of [
      { enabled: true, start: "22:00", end: "07:00", timezone: "Mars/Olympus_Mons" },
      { enabled: true, start: "05:00", end: "05:00", timezone: "America/Denver" }
    ]) {
      await expect(
        dataContext.withDataContext(
          { actorUserId: ids.userA, requestId: "req:quiet-hours-invalid" },
          (scopedDb) => quietHoursSetExecute(scopedDb, input, toolCtx(ids.userA))
        )
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await readAs(ids.userA)).toEqual(before);
  });

  it("keeps the saved timezone when the request omits it", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:quiet-hours-omit-tz" },
      (scopedDb) =>
        quietHoursSetExecute(
          scopedDb,
          { enabled: true, start: "23:30", end: "06:15" },
          toolCtx(ids.userA)
        )
    );
    expect(result.data).toEqual({
      enabled: true,
      start: "23:30",
      end: "06:15",
      timezone: "America/Denver"
    });
  });

  it("keeps a saved legacy equal-time window when only the switch changes", async () => {
    await dataContext.withDataContext(
      { actorUserId: ids.userC, requestId: "req:quiet-hours-legacy-seed" },
      (scopedDb) =>
        preferences.upsert(scopedDb, QUIET_HOURS_PREFERENCE_KEY, {
          enabled: false,
          start: "22:00",
          end: "22:00",
          timezone: null
        })
    );
    await dataContext.withDataContext(
      { actorUserId: ids.userC, requestId: "req:quiet-hours-legacy" },
      (scopedDb) =>
        quietHoursSetExecute(
          scopedDb,
          { enabled: true, start: "22:00", end: "22:00", timezone: null },
          toolCtx(ids.userC)
        )
    );
    expect((await readAs(ids.userC))?.value).toEqual({
      enabled: true,
      start: "22:00",
      end: "22:00",
      timezone: null
    });
  });

  function readAs(actorUserId: string) {
    return dataContext.withDataContext(
      { actorUserId, requestId: "req:quiet-hours-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, QUIET_HOURS_PREFERENCE_KEY)
    );
  }
});
