/**
 * #3390: a briefing run reads the owner's saved locale and writes event times in it, even
 * when the definition's stored schedule timezone is UTC. Covers the real preference read
 * under RLS inside generateRun, which the unit tests bypass by passing the locale in, and
 * the routes and worker that move the job schedule into the owner's zone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { GenerateChatInput } from "@moss/ai";
import {
  BRIEFINGS_RUN_QUEUE,
  reconcileSchedule,
  type BriefingsRepository,
  type ComposeDeps,
  type GenerateChatFn
} from "@moss/briefings";
import type { DataContextRunner, MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { strictLocalWallClockToInstant, type MossModuleManifest } from "@moss/module-sdk";
import { localDay } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import {
  handleNextBriefingJob,
  makeComposeDeps,
  setupBriefingsHarness,
  spyBossSchedule,
  teardownBriefingsHarness,
  userAContext,
  userAHeaders,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

const PACIFIC = "America/Los_Angeles";

/** Built-in manifests with the calendar read tool returning one event at 10:15 Pacific today. */
function manifestsWithStandup(): readonly MossModuleManifest[] {
  const startsAt = strictLocalWallClockToInstant(
    `${localDay(new Date(), PACIFIC)}T10:15:00`,
    PACIFIC
  );
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const event = {
    id: "evt-standup",
    title: "Standup",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    allDay: false,
    location: null
  };
  return getBuiltInModuleManifests().map((manifest) => ({
    ...manifest,
    assistantTools: (manifest.assistantTools ?? []).map((tool) =>
      tool.name === "calendar.listVisibleEvents"
        ? { ...tool, execute: async () => ({ data: { events: [event], accounts: [], gaps: [] } }) }
        : tool
    )
  }));
}

/** Compose deps that read the owner's saved locale, with a fake model and no provider call. */
function personTimeComposeDeps(
  generateChat: GenerateChatFn,
  moduleManifests: readonly MossModuleManifest[] = getBuiltInModuleManifests()
): ComposeDeps {
  const deps = {
    ...makeComposeDeps(generateChat, moduleManifests),
    localePreferences: new PreferencesRepository()
  };
  // @ts-expect-error mock
  deps.aiRepository = {
    selectModelForCapability: async () => ({
      provider_config_id: "test",
      provider_kind: "anthropic",
      id: "test",
      display_name: "test",
      tier: "economy"
    }),
    selectProviderWithCredential: async () => ({
      encrypted_credential: await deps.cipher.encryptJson({ apiKey: "canary-key" })
    })
  } as unknown;
  return deps;
}

describe("briefing runs write times in the owner's saved locale (#3390)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: BriefingsRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];
  const prefs = new PreferencesRepository();

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    dataContext = harness.dataContext;
    repository = harness.repository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
  });

  afterAll(async () => {
    await dataContext.withDataContext(userAContext(), (db) => prefs.delete(db, "locale"));
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
  });

  it("writes a Pacific 12-hour owner's event as 10:15 AM for a definition stored as UTC", async () => {
    await dataContext.withDataContext(userAContext(), (db) =>
      prefs.upsert(db, "locale", { timezone: PACIFIC, region: "en-US", dateFormat: "12" })
    );
    const definition = await dataContext.withDataContext(userAContext(), (db) =>
      repository.createDefinition(db, {
        title: "Person time morning",
        briefingType: "morning",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        selectedToolNames: ["calendar.listVisibleEvents"]
      })
    );

    const prompts: string[] = [];
    const moduleManifests = manifestsWithStandup();
    const deps = personTimeComposeDeps(async (input: GenerateChatInput) => {
      prompts.push(input.messages.map((m) => m.content).join("\n"));
      return { text: "synth narrative" };
    }, moduleManifests);

    const result = await dataContext.withDataContext(userAContext(), (db) =>
      repository.generateRun(db, definition.id, {
        moduleManifests,
        runKind: "manual",
        composeDeps: deps
      })
    );

    expect(result!.run.status).toBe("succeeded");
    const prompt = prompts.join("\n");
    expect(prompt).toContain("10:15 AM-10:45 AM · Standup");
    expect(prompt).not.toMatch(/\b(17|18):15\b/);
  });

  it("re-registers a UTC cron in the owner's zone when it fires, without a screen visit", async () => {
    await dataContext.withDataContext(userAContext(), (db) =>
      prefs.upsert(db, "locale", { timezone: PACIFIC, region: "en-US", dateFormat: "12" })
    );
    const definition = await dataContext.withDataContext(userAContext(), (db) =>
      repository.createDefinition(db, {
        title: "Person time realign",
        briefingType: "morning",
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        selectedToolNames: ["calendar.listVisibleEvents"]
      })
    );
    try {
      // The cron as it stands for a briefing created before #3390: registered in UTC.
      await reconcileSchedule(appBoss, definition);
      expect((await appBoss.getSchedules(BRIEFINGS_RUN_QUEUE, definition.id))[0]?.timezone).toBe(
        "UTC"
      );

      await appBoss.send(BRIEFINGS_RUN_QUEUE, {
        actorUserId: definition.owner_user_id,
        definitionId: definition.id,
        runKind: "scheduled",
        briefingType: "morning"
      });
      await handleNextBriefingJob(
        workerBoss,
        personTimeComposeDeps(async () => ({ text: "synth narrative" }))
      );

      const [schedule] = await appBoss.getSchedules(BRIEFINGS_RUN_QUEUE, definition.id);
      expect(schedule?.timezone).toBe(PACIFIC);
      expect(schedule?.cron).toBe("0 7 * * *");
    } finally {
      await appBoss.unschedule(BRIEFINGS_RUN_QUEUE, definition.id);
    }
  });

  it("uses the owner's saved timezone on update, on the list self-heal and for a create with no timezone (#3390)", async () => {
    const prefs = new PreferencesRepository();
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      prefs.upsert(scopedDb, "locale", {
        timezone: "America/New_York",
        region: "en-US",
        dateFormat: "12"
      })
    );
    const stored = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Owner zone wiring",
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        enabled: true,
        selectedToolNames: ["tasks.list"]
      })
    );
    const calls = spyBossSchedule(appBoss);
    try {
      const updated = await server.inject({
        method: "PATCH",
        url: `/api/briefings/definitions/${stored.id}`,
        headers: userAHeaders(),
        payload: { scheduleMetadata: { targetTime: "06:30", timezone: "UTC" } }
      });
      expect(updated.statusCode).toBe(200);
      expect(calls.schedule.filter((c) => c.key === stored.id)).toEqual([
        expect.objectContaining({ cron: "30 6 * * *", tz: "America/New_York" })
      ]);

      calls.schedule.length = 0;
      const listed = await server.inject({
        method: "GET",
        url: "/api/briefings/definitions",
        headers: userAHeaders()
      });
      expect(listed.statusCode).toBe(200);
      await vi.waitFor(() =>
        expect(calls.schedule.filter((c) => c.key === stored.id)).toEqual([
          expect.objectContaining({ tz: "America/New_York" })
        ])
      );

      const created = await server.inject({
        method: "POST",
        url: "/api/briefings/definitions",
        headers: userAHeaders(),
        payload: {
          title: "No zone given",
          cadence: "daily",
          scheduleMetadata: { targetTime: "06:00" },
          enabled: true,
          selectedToolNames: ["tasks.list"]
        }
      });
      expect(created.statusCode).toBe(201);
      const createdDefinition = created.json<{
        definition: { scheduleMetadata: Record<string, unknown> };
      }>().definition;
      expect(createdDefinition.scheduleMetadata).toMatchObject({
        targetTime: "06:00",
        timezone: "America/New_York"
      });
    } finally {
      calls.restore();
      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        prefs.delete(scopedDb, "locale")
      );
    }
  });
});
