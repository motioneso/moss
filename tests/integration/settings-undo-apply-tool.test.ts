import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { ProactiveMonitoringPreferencesRepository } from "@moss/proactive-monitoring";
import { PreferencesRepository } from "@moss/structured-state";
import { registerProactiveMonitoringSettingsRoutes } from "../../packages/settings/src/proactive-monitoring-routes.js";
import { quietHoursSetExecute } from "../../packages/settings/src/quiet-hours-tool.js";
import { registerQuietHoursRoutes } from "../../packages/settings/src/quiet-hours-routes.js";
import { themeModeSetExecute } from "../../packages/settings/src/theme-mode-tool.js";
import { settingsUndoLastExecute } from "../../packages/settings/src/undo-apply-tool.js";
import { settingsUndoStack } from "../../packages/settings/src/undo-stack.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const COLOR_MODE_KEY = "themes.color-mode";

function toolCtx(actorUserId: string): ToolContext {
  return { actorUserId, requestId: "req:undo-apply-tool-test", chatSessionId: "" };
}

describe("settings.undoLast tool", () => {
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

  it("reports nothing to undo when the stack is empty", async () => {
    settingsUndoStack.clear(ids.userA, "");
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-empty" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(ids.userA))
    );
    expect(result.data).toEqual({
      status: "nothing_to_undo",
      key: null,
      message: "There's nothing to undo."
    });
  });

  it("undoes a tracked write immediately after it lands (absent-row case: deletes the row)", async () => {
    settingsUndoStack.clear(ids.userA, "");
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-absent-write" },
      (scopedDb) => themeModeSetExecute(scopedDb, { mode: "dark" }, toolCtx(ids.userA))
    );
    const afterWrite = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-absent-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, COLOR_MODE_KEY)
    );
    expect(afterWrite?.value).toBe("dark");

    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-absent-undo" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(ids.userA))
    );
    expect(result.data).toEqual({
      status: "undone",
      key: COLOR_MODE_KEY,
      message: "Changed that back."
    });

    const afterUndo = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-absent-after" },
      (scopedDb) => preferences.getWithRevision(scopedDb, COLOR_MODE_KEY)
    );
    expect(afterUndo).toBeNull();
  });

  it("undoes a tracked write over an existing row (restores the prior value and revision)", async () => {
    settingsUndoStack.clear(ids.userB, "");
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:undo-existing-seed" },
      (scopedDb) => themeModeSetExecute(scopedDb, { mode: "dark" }, toolCtx(ids.userB))
    );
    settingsUndoStack.clear(ids.userB, "");
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:undo-existing-write" },
      (scopedDb) => themeModeSetExecute(scopedDb, { mode: "light" }, toolCtx(ids.userB))
    );

    const result = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:undo-existing-undo" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(ids.userB))
    );
    expect(result.data).toEqual({
      status: "undone",
      key: COLOR_MODE_KEY,
      message: "Changed that back."
    });

    const afterUndo = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:undo-existing-after" },
      (scopedDb) => preferences.getWithRevision(scopedDb, COLOR_MODE_KEY)
    );
    // CAS revision is monotonic — undo is itself a new write, so it bumps past the tracked
    // write's own resulting revision (2) rather than reverting the counter to the pre-mutation
    // value (1). Only the VALUE rolls back, not the revision number.
    expect(afterUndo?.value).toBe("dark");
    expect(afterUndo?.revision).toBe(3);
  });

  it("refuses when a plain write landed on top since the tracked mutation, and leaves it untouched", async () => {
    settingsUndoStack.clear(ids.adminUser, "");
    // Seed an existing row outside CAS tracking so the tracked write below exercises the
    // upsert (non-absent-row) undo branch.
    await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:undo-conflict-seed" },
      (scopedDb) => preferences.upsert(scopedDb, COLOR_MODE_KEY, "light")
    );
    await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:undo-conflict-tracked" },
      (scopedDb) => themeModeSetExecute(scopedDb, { mode: "dark" }, toolCtx(ids.adminUser))
    );
    // A plain (non-CAS) write lands on top of the tracked mutation, outside undo's knowledge —
    // this is the scenario the coordinator's binding ruling requires a direct test for.
    await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:undo-conflict-interleave" },
      (scopedDb) => preferences.upsert(scopedDb, COLOR_MODE_KEY, "light")
    );

    const result = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:undo-conflict-undo" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(ids.adminUser))
    );
    expect(result.data).toEqual({
      status: "cancelled",
      key: COLOR_MODE_KEY,
      message: "That setting changed again since, so I didn't undo it."
    });

    const afterCancelled = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:undo-conflict-after" },
      (scopedDb) => preferences.getWithRevision(scopedDb, COLOR_MODE_KEY)
    );
    expect(afterCancelled?.value).toBe("light");
    expect(afterCancelled?.revision).toBe(3);
  });

  it("consumes the entry on a successful undo — a second undo finds nothing to redo", async () => {
    settingsUndoStack.clear(ids.userA, "");
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-twice-write" },
      (scopedDb) => themeModeSetExecute(scopedDb, { mode: "dark" }, toolCtx(ids.userA))
    );

    const first = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-twice-first" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(ids.userA))
    );
    expect(first.data.status).toBe("undone");

    const second = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:undo-twice-second" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(ids.userA))
    );
    expect(second.data).toEqual({
      status: "nothing_to_undo",
      key: null,
      message: "There's nothing to undo."
    });
  });
});

describe("settings.undoLast over quiet-hours writes", () => {
  const QUIET_HOURS_KEY = "quiet-hours";
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let app: FastifyInstance;
  const preferences = new PreferencesRepository();
  const proactive = new ProactiveMonitoringPreferencesRepository();

  beforeAll(async () => {
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    app = Fastify();
    const resolveAccessContext = async (request: { headers: Record<string, unknown> }) => ({
      actorUserId: String(request.headers["x-test-actor"]),
      requestId: "req:undo-quiet-rest"
    });
    registerQuietHoursRoutes(app, {
      dataContext,
      resolveAccessContext,
      preferencesRepository: preferences
    });
    registerProactiveMonitoringSettingsRoutes(app, { dataContext, resolveAccessContext });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await appDb?.destroy();
  });

  it("restores the previous schedule once, and a repeat undo does nothing", async () => {
    const actor = ids.userA;
    settingsUndoStack.clear(actor, "");
    await setQuietHours(actor, { enabled: true, start: "22:00", end: "07:00", timezone: null });
    const before = await readQuiet(actor);
    await setQuietHours(actor, { enabled: true, start: "23:00", end: "06:00", timezone: null });

    expect((await undo(actor)).status).toBe("undone");
    const restored = await readQuiet(actor);
    expect(restored?.value).toEqual(before?.value);

    // The restore bumped the revision, so the older create entry no longer matches the row.
    expect((await undo(actor)).status).toBe("cancelled");
    expect((await readQuiet(actor))?.value).toEqual(before?.value);
    expect((await undo(actor)).status).toBe("nothing_to_undo");
  });

  it("removes a schedule the tool created when there was none", async () => {
    const actor = ids.userB;
    settingsUndoStack.clear(actor, "");
    await setQuietHours(actor, { enabled: true, start: "21:30", end: "06:30", timezone: null });
    expect((await undo(actor)).status).toBe("undone");
    expect(await readQuiet(actor)).toBeNull();
    expect((await undo(actor)).status).toBe("nothing_to_undo");
  });

  it("refuses to undo over a later Account & preferences save", async () => {
    const actor = ids.adminUser;
    settingsUndoStack.clear(actor, "");
    await setQuietHours(actor, { enabled: true, start: "22:00", end: "07:00", timezone: null });
    const version = (await restGet(actor)).version;
    const put = await app.inject({
      method: "PUT",
      url: "/api/me/quiet-hours",
      headers: { "x-test-actor": actor },
      payload: {
        quietHours: { enabled: true, start: "20:00", end: "05:00", timezone: "Europe/Paris" },
        expectedVersion: version
      }
    });
    expect(put.statusCode).toBe(200);

    expect(await undo(actor)).toMatchObject({
      status: "cancelled",
      message: "That setting changed again since, so I didn't undo it."
    });
    expect((await readQuiet(actor))?.value).toEqual({
      enabled: true,
      start: "20:00",
      end: "05:00",
      timezone: "Europe/Paris"
    });
  });

  it("does not delete a schedule recreated after an undo removed the tool's create", async () => {
    const actor = ids.userC;
    settingsUndoStack.clear(actor, "");
    await setQuietHours(actor, { enabled: true, start: "22:00", end: "07:00", timezone: null });
    expect((await undo(actor)).status).toBe("undone");
    expect(await readQuiet(actor)).toBeNull();

    const put = await app.inject({
      method: "PUT",
      url: "/api/me/quiet-hours",
      headers: { "x-test-actor": actor },
      payload: {
        quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: null },
        expectedVersion: null
      }
    });
    expect(put.statusCode).toBe(200);
    const recreated = await readQuiet(actor);
    expect(recreated?.revision).toBe(1);

    expect((await undo(actor)).status).toBe("nothing_to_undo");
    expect(await readQuiet(actor)).toEqual(recreated);
  });

  it("cancels every stacked undo once a later save lands on top of them", async () => {
    const actor = ids.userD;
    settingsUndoStack.clear(actor, "");
    await setQuietHours(actor, { enabled: true, start: "22:00", end: "07:00", timezone: null });
    await setQuietHours(actor, { enabled: true, start: "23:00", end: "07:00", timezone: null });
    const version = (await restGet(actor)).version;
    const put = await app.inject({
      method: "PUT",
      url: "/api/me/quiet-hours",
      headers: { "x-test-actor": actor },
      payload: {
        quietHours: { enabled: false, start: "23:00", end: "07:00", timezone: null },
        expectedVersion: version
      }
    });
    expect(put.statusCode).toBe(200);
    const latest = await readQuiet(actor);

    expect((await undo(actor)).status).toBe("cancelled");
    expect((await undo(actor)).status).toBe("cancelled");
    expect((await undo(actor)).status).toBe("nothing_to_undo");
    expect(await readQuiet(actor)).toEqual(latest);
  });

  it("leaves the separate alert quiet hours alone when undoing a Profile change", async () => {
    const actor = ids.userA;
    settingsUndoStack.clear(actor, "");
    await setQuietHours(actor, { enabled: true, start: "22:30", end: "06:45", timezone: null });
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/me/proactive-monitoring-settings",
      headers: { "x-test-actor": actor },
      payload: { quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "08:00" } }
    });
    expect(patch.statusCode).toBe(200);

    expect((await undo(actor)).status).toBe("undone");
    const alerts = await dataContext.withDataContext(
      { actorUserId: actor, requestId: "req:undo-quiet-proactive" },
      (scopedDb) => proactive.getSaved(scopedDb)
    );
    expect(alerts?.raw.quietHours).toEqual({
      enabled: true,
      startLocalTime: "21:00",
      endLocalTime: "08:00"
    });
  });

  function setQuietHours(actor: string, input: Record<string, unknown>) {
    return dataContext.withDataContext(
      { actorUserId: actor, requestId: "req:undo-quiet-set" },
      (scopedDb) => quietHoursSetExecute(scopedDb, input, toolCtx(actor))
    );
  }

  async function undo(actor: string) {
    const result = await dataContext.withDataContext(
      { actorUserId: actor, requestId: "req:undo-quiet-undo" },
      (scopedDb) => settingsUndoLastExecute(scopedDb, {}, toolCtx(actor))
    );
    return result.data as { status: string; key: string | null; message: string };
  }

  function readQuiet(actor: string) {
    return dataContext.withDataContext(
      { actorUserId: actor, requestId: "req:undo-quiet-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, QUIET_HOURS_KEY)
    );
  }

  async function restGet(actor: string): Promise<{ version: string | null }> {
    const response = await app.inject({
      method: "GET",
      url: "/api/me/quiet-hours",
      headers: { "x-test-actor": actor }
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
});
