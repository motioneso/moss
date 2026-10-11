/**
 * #3390: a briefing run reads the owner's saved locale and writes event times in it, even
 * when the definition's stored schedule timezone is UTC. Covers the real preference read
 * under RLS inside generateRun, which the unit tests bypass by passing the locale in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { GenerateChatInput } from "@moss/ai";
import type { BriefingsRepository } from "@moss/briefings";
import type { DataContextRunner, MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { strictLocalWallClockToInstant, type MossModuleManifest } from "@moss/module-sdk";
import { localDay } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import {
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
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
    const deps = {
      ...makeComposeDeps(async (input: GenerateChatInput) => {
        prompts.push(input.messages.map((m) => m.content).join("\n"));
        return { text: "synth narrative" };
      }, moduleManifests),
      localePreferences: prefs
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
});
