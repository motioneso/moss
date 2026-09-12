import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";

import { registerCalendarRoutes } from "../../packages/calendar/src/routes.js";

const userA: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};

function makePreferences(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const preferences: PreferencesPort = {
    get: async (_db: DataContextDb, key: string) => store.get(key),
    upsert: async (_db: DataContextDb, key: string, value: unknown) => {
      store.set(key, value);
    }
  } as unknown as PreferencesPort;
  return { preferences, store };
}

function buildApp(initial: Record<string, unknown> = {}) {
  const { preferences, store } = makePreferences(initial);
  const policyWrites: Array<{ moduleId: string; actionFamilyId: string; tier: string }> = [];
  const app = Fastify();
  registerCalendarRoutes(app, {
    resolveAccessContext: async () => userA,
    dayPlanRepository: { getForDay: async () => undefined },
    resolveTimeZone: async () => "UTC",
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    preferencesRepository: preferences,
    calendarWritebackPolicy: {
      set: async (_db, moduleId, actionFamilyId, tier) => {
        policyWrites.push({ moduleId, actionFamilyId, tier });
      }
    }
  });
  return { app, store, policyWrites };
}

describe("calendar briefing-settings routes (#736)", () => {
  it("GET defaults modes to suggest/suggest", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/calendar/briefing-settings" });

    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      prepTaskMode: "suggest",
      timeBlockMode: "suggest",
      suggestTasks: true,
      createTasks: false,
      suggestTimeBlocks: true,
      blockTime: false
    });
    await app.close();
  });

  it("GET normalizes invalid stored modes back to defaults", async () => {
    const { app } = buildApp({
      "calendar.prep_task_mode": "everything",
      "calendar.time_block_mode": "never"
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/calendar/briefing-settings" });

    expect(res.json().settings).toMatchObject({
      prepTaskMode: "suggest",
      timeBlockMode: "suggest"
    });
    await app.close();
  });

  it("PATCH persists modes and derives legacy booleans", async () => {
    const { app, store, policyWrites } = buildApp();
    await app.ready();
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/calendar/briefing-settings",
      payload: { prepTaskMode: "auto", timeBlockMode: "off" }
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().settings).toMatchObject({
      prepTaskMode: "auto",
      timeBlockMode: "off",
      suggestTasks: true,
      createTasks: true,
      suggestTimeBlocks: false,
      blockTime: false
    });
    expect(store.get("calendar.prep_task_mode")).toBe("auto");
    expect(store.get("calendar.time_block_mode")).toBe("off");
    expect(policyWrites).toEqual([
      {
        moduleId: "calendar",
        actionFamilyId: "calendar_writeback",
        tier: "ask_each_time"
      }
    ]);
    await app.close();
  });

  it("PATCH mode=auto atomically updates calendar_writeback to trusted_auto", async () => {
    const { app, policyWrites } = buildApp();
    await app.ready();
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/calendar/briefing-settings",
      payload: { timeBlockMode: "auto" }
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().settings.blockTime).toBe(true);
    expect(policyWrites).toEqual([
      {
        moduleId: "calendar",
        actionFamilyId: "calendar_writeback",
        tier: "trusted_auto"
      }
    ]);
    await app.close();
  });

  it("PATCH rejects an unknown mode with 400", async () => {
    const { app, store } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/calendar/briefing-settings",
      payload: { prepTaskMode: "yolo" }
    });

    expect(res.statusCode).toBe(400);
    expect(store.has("calendar.prep_task_mode")).toBe(false);
    await app.close();
  });
});
