import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Kysely } from "kysely";

import { AiRepository } from "@moss/ai";
import { createActAsGrantRegistry } from "@moss/auth";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createRouteCatalogHolder } from "@moss/module-registry";
import { PreferencesRepository } from "@moss/structured-state";
import { WellnessRepository } from "@moss/wellness";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  createAppActionsService,
  type AppActionCallInput,
  type AppActionsService
} from "../../packages/chat/src/app-actions.js";
import {
  aggregateConsentCalls,
  appActionCatalog,
  appActionContext,
  blockedWellnessCalls,
  makeAppActionGateway,
  medicationSentinel,
  therapySentinel,
  themeTokens
} from "../fixtures/app-actions-gateway.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Run only through the isolated verify-gate / hosted CI integration entry point.
// These tests use the real API, grants, route handlers, scoped SQL, catalog, tools and gateway.
// The offline unit sibling intentionally substitutes only persistence and HTTP transport.
describe("app actions through the real gateway and app routes", () => {
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let appActions: AppActionsService;
  let callSpy: MockInstance<AppActionsService["call"]>;
  let checkinId: string;
  let medicationId: string;
  const preferences = new PreferencesRepository();
  const grants = createActAsGrantRegistry();
  const mintSpy = vi.spyOn(grants, "mint");
  const access = { actorUserId: ids.userA, requestId: "app-actions-integration" };

  function gateway(
    options: {
      actorUserId?: string;
      autoApprove?: boolean;
      forceConfirm?: boolean;
      withoutPerCallWiring?: boolean;
    } = {}
  ) {
    return makeAppActionGateway({
      runner,
      appActions,
      repository: new AiRepository(),
      confirmTimeoutMs: 10_000,
      ...options
    });
  }

  async function browser(input: AppActionCallInput) {
    return server.inject({
      method: input.method,
      url: input.path,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      ...(input.query ? { query: input.query } : {}),
      ...(input.body === undefined ? {} : { payload: input.body as Record<string, unknown> })
    });
  }

  async function consent(value: boolean) {
    const response = await browser({
      method: "PUT",
      path: "/api/wellness/ai-consent",
      body: { granted: value }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ effective: value, explicit: value });
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    // A single connection exposes any unused outer gateway transaction around app route injection.
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(appDb);
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, actAsGrants: grants, logger: false });
    await server.ready();
    const catalog = createRouteCatalogHolder();
    catalog.set(appActionCatalog);
    appActions = createAppActionsService({ server, catalog, grants, readTurnId: () => null });
    callSpy = vi.spyOn(appActions, "call");

    // Prove the seeded bearer session reaches the real actor before attributing fixture errors
    // to authentication. These requests still use the full API auth and route-guard stack.
    const authenticated = await browser({ method: "GET", path: "/api/me" });
    expect(authenticated.statusCode, "fixture bearer session must authenticate").toBe(200);
    expect(authenticated.json()).toMatchObject({ user: { id: ids.userA } });

    // POST /wellness/checkins has an existing nested active-module lookup in its recall refresh.
    // Seed the needed row through the actor-scoped repository so that unrelated route behavior
    // cannot consume our sole connection before the app-action pool-one regressions even start.
    const wellness = new WellnessRepository();
    const checkin = await runner.withDataContext(access, (db) =>
      wellness.createCheckin(db, { feelingCore: "happy", note: therapySentinel }, "UTC")
    );
    expect(checkin).toMatchObject({ owner_user_id: ids.userA, note: therapySentinel });
    checkinId = checkin.id;
    const checkins = await browser({ method: "GET", path: "/api/wellness/checkins" });
    expect(checkins.statusCode).toBe(200);
    expect(checkins.json()).toMatchObject({
      checkins: expect.arrayContaining([
        expect.objectContaining({ id: checkinId, ownerUserId: ids.userA, note: therapySentinel })
      ])
    });
    const medication = await browser({
      method: "POST",
      path: "/api/wellness/medications",
      body: { name: medicationSentinel, frequencyType: "as_needed" }
    });
    expect(medication.statusCode).toBe(201);
    medicationId = medication.json<{ medication: { id: string } }>().medication.id;
    expect(medication.json()).toMatchObject({
      medication: {
        id: medicationId,
        ownerUserId: ids.userA,
        name: medicationSentinel,
        frequencyType: "as_needed"
      }
    });
    const therapy = await browser({
      method: "POST",
      path: "/api/wellness/therapy-notes",
      body: { body: therapySentinel }
    });
    expect(therapy.statusCode).toBe(201);
    expect(therapy.json()).toMatchObject({
      note: { ownerUserId: ids.userA, body: therapySentinel }
    });
    // Demonstrate that the withheld records really exist and ordinary actor-scoped routes return them.
    const medications = await browser({ method: "GET", path: "/api/wellness/medications" });
    expect(medications.statusCode).toBe(200);
    expect(medications.body).toContain(medicationSentinel);
    const therapyNotes = await browser({ method: "GET", path: "/api/wellness/therapy-notes" });
    expect(therapyNotes.statusCode).toBe(200);
    expect(therapyNotes.body).toContain(therapySentinel);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it.each([
    ["PATCH", "/api/me/profile", "blocked"],
    ["GET", "/api/not-a-real-route", "unknown_route"]
  ] as const)("refuses %s %s before any transport call", async (method, path, reason) => {
    callSpy.mockClear();
    expect(await gateway().call({ method, path })).toMatchObject({
      ok: false,
      denied: true,
      reason: expect.stringMatching(new RegExp(`^${reason}(?:: |$)`))
    });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("mints no grant when missing per-call wiring reaches the production not_ready marker", async () => {
    callSpy.mockClear();
    mintSpy.mockClear();
    const h = gateway({ withoutPerCallWiring: true });
    const input = {
      method: "PUT" as const,
      path: "/api/me/weather-unit",
      body: { unit: "metric" }
    };
    const marker = h.dependencies.toolServices?.appActions as Pick<AppActionsService, "call">;
    await expect(marker.call(input, appActionContext)).rejects.toMatchObject({ code: "not_ready" });
    expect(await h.call(input)).toMatchObject({ ok: false });
    expect(callSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it("refuses an instance admin calling an admin route", async () => {
    callSpy.mockClear();
    expect(
      await gateway({ actorUserId: ids.adminUser }).call({
        method: "GET",
        path: "/api/admin/users"
      })
    ).toMatchObject({ ok: false, denied: true, reason: expect.stringMatching(/^blocked(?:: |$)/) });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("refuses a consent-off Wellness write without returning or modifying its stored row", async () => {
    await consent(false);
    callSpy.mockClear();
    const result = await gateway().call({
      method: "PATCH",
      path: `/api/wellness/checkins/${checkinId}`,
      body: { feelingCore: "happy", note: "changed by chat" }
    });
    expect(result).toMatchObject({ ok: false, denied: true, reason: "consent_off" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(therapySentinel);
    expect((await browser({ method: "GET", path: "/api/wellness/checkins" })).body).toContain(
      therapySentinel
    );
    await consent(true);
  });

  it.each(blockedWellnessCalls())(
    "with consent, refuses blocked Wellness $method $path and withholds sentinel rows",
    async (input) => {
      await consent(true);
      callSpy.mockClear();
      const h = gateway();
      const result = await h.call({
        ...input,
        path: input.path.replace("00000000-0000-4000-8000-000000000041", medicationId)
      });
      expect(result).toMatchObject({
        ok: false,
        denied: true,
        reason: expect.stringMatching(/^blocked(?:: |$)/)
      });
      expect(callSpy).not.toHaveBeenCalled();
      expect(JSON.stringify([result, h.events])).not.toContain(medicationSentinel);
      expect(JSON.stringify([result, h.events])).not.toContain(therapySentinel);
    }
  );

  it.each(aggregateConsentCalls)(
    "refuses aggregate-consent alias before transport or grant minting: $method $path",
    async (input) => {
      await consent(false);
      callSpy.mockClear();
      mintSpy.mockClear();
      const h = gateway();
      expect(await h.call(input)).toMatchObject({
        ok: false,
        denied: true,
        reason: expect.stringMatching(/^blocked(?:: |$)/)
      });
      expect(callSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      await consent(true);
    }
  );

  it("completes concurrent allowed app reads with a single database connection", async () => {
    callSpy.mockClear();
    const h = gateway();
    const results = await Promise.all([
      h.call({ method: "GET", path: "/api/me/themes" }),
      h.call({ method: "GET", path: "/api/me/weather-unit" }),
      h.call({ method: "GET", path: "/api/me/locale" })
    ]);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toMatchObject({ ok: true, structuredData: { status: 200 } });
    }
    expect(callSpy).toHaveBeenCalledTimes(3);
    expect(h.events).toEqual([]);
  });

  it("deletes two themes through approved cards with distinct server-read targets", async () => {
    for (const [id, name] of [
      ["boundary-forest", "Boundary Forest"],
      ["boundary-ocean", "Boundary Ocean"]
    ]) {
      expect(
        (
          await browser({
            method: "PUT",
            path: `/api/me/themes/${id}`,
            body: { name, tokens: themeTokens }
          })
        ).statusCode
      ).toBe(200);
    }
    const h = gateway();
    expect(
      await h.call({ method: "DELETE", path: "/api/me/themes/boundary-forest" })
    ).toMatchObject({ ok: true });
    expect(await h.call({ method: "DELETE", path: "/api/me/themes/boundary-ocean" })).toMatchObject(
      { ok: true }
    );
    const cards = h.events.filter((event) => event.kind === "action_request");
    expect(cards.map((card) => card.details?.target)).toEqual([
      "Boundary Forest",
      "Boundary Ocean"
    ]);
    const themes = (await browser({ method: "GET", path: "/api/me/themes" })).json<{
      custom: { id: string }[];
    }>();
    expect(themes.custom.map((theme) => theme.id)).not.toContain("boundary-forest");
    expect(themes.custom.map((theme) => theme.id)).not.toContain("boundary-ocean");
  });

  it("emits settings refresh scope only after a successful real write", async () => {
    const h = gateway();
    expect(
      await h.call({ method: "PUT", path: "/api/me/weather-unit", body: { unit: "metric" } })
    ).toMatchObject({ ok: true });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: "action_result",
        outcome: "executed",
        affectsModules: ["settings"]
      })
    );
    expect((await browser({ method: "GET", path: "/api/me/weather-unit" })).json()).toMatchObject({
      unit: "metric"
    });
  });

  it("keeps a rejected HTTP write out of success events and refresh scope", async () => {
    const h = gateway();
    const response = await h.call({
      method: "PUT",
      path: "/api/me/weather-unit",
      body: { unit: "invalid" }
    });
    expect(response).toMatchObject({ ok: true, structuredData: { ok: false, status: 400 } });
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "error" })
    );
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
    expect(
      h.events
        .filter((event) => event.kind === "action_result")
        .every((event) => event.affectsModules === undefined)
    ).toBe(true);
    expect((await browser({ method: "GET", path: "/api/me/weather-unit" })).json()).toMatchObject({
      unit: "metric"
    });
  });

  it("caps a real oversized themes response with the existing truncation note", async () => {
    await runner.withDataContext(access, (db) =>
      preferences.upsert(
        db,
        "themes.custom",
        Array.from({ length: 100 }, (_, i) => ({
          id: `large-${i}`,
          name: `Large theme ${i}`,
          tokens: themeTokens
        }))
      )
    );
    const response = await gateway().call({ method: "GET", path: "/api/me/themes" });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(String(response.data.text)).toHaveLength(16_000);
    expect(response.data.text).toContain("[truncated tool result]");
  });

  it("refuses not_ready without injecting while the holder is empty", async () => {
    const earlyActions = createAppActionsService({
      server,
      catalog: createRouteCatalogHolder(),
      grants,
      readTurnId: () => null
    });
    const earlySpy = vi.spyOn(earlyActions, "call");
    const h = makeAppActionGateway({
      runner,
      appActions: earlyActions,
      repository: new AiRepository()
    });
    expect(await h.call({ method: "GET", path: "/api/me/themes" })).toMatchObject({
      ok: false,
      denied: true,
      reason: "not_ready"
    });
    expect(earlySpy).not.toHaveBeenCalled();
  });

  it("resolves weather search as read and confirmWhenTainted without contacting the provider", async () => {
    callSpy.mockClear();
    expect(
      await gateway().resolver(
        { method: "GET", path: "/api/me/weather-location/search", query: { q: "Paris" } },
        appActionContext
      )
    ).toMatchObject({ kind: "proceed", risk: "read", confirmWhenTainted: true });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("refuses a write when consent changes while its approval is pending", async () => {
    await consent(true);
    callSpy.mockClear();
    const h = gateway({ autoApprove: false, forceConfirm: true });
    const pending = h.call({
      method: "PATCH",
      path: `/api/wellness/checkins/${checkinId}`,
      body: { feelingCore: "happy", note: "must not be written" }
    });
    await vi.waitFor(
      () => expect(h.events.some((event) => event.kind === "action_request")).toBe(true),
      { timeout: 5_000 }
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    await consent(false);
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    await pending;
    expect(callSpy).not.toHaveBeenCalled();
    expect((await browser({ method: "GET", path: "/api/wellness/checkins" })).body).toContain(
      therapySentinel
    );
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
    await consent(true);
  });
  it("persists a forced-confirm read as read and completes the real approval round trip", async () => {
    callSpy.mockClear();
    // Force only the policy seam; keep the real resolver, read transport and SQL action repository.
    const h = gateway({ autoApprove: false, forceConfirm: true });
    const pending = h.call({ method: "GET", path: "/api/me/themes" });
    await vi.waitFor(
      () => expect(h.events.some((event) => event.kind === "action_request")).toBe(true),
      { timeout: 5_000 }
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    expect(callSpy).not.toHaveBeenCalled();
    const stored = await runner.withDataContext(access, (db) =>
      h.repository.getAssistantAction(db, card.actionRequestId)
    );
    expect(stored).toMatchObject({ risk: "read", status: "pending", owner_user_id: ids.userA });
    expect(await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed")).toBe(
      "resolved"
    );
    expect(await pending).toMatchObject({ ok: true });
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(
      await runner.withDataContext(access, (db) =>
        h.repository.getAssistantAction(db, card.actionRequestId)
      )
    ).toMatchObject({ risk: "read", status: "confirmed" });
  });

  it("does not delete a theme renamed while its approval card is pending", async () => {
    expect(
      (
        await browser({
          method: "PUT",
          path: "/api/me/themes/rename-during-hold",
          body: { name: "Approved original", tokens: themeTokens }
        })
      ).statusCode
    ).toBe(200);
    callSpy.mockClear();
    const h = gateway({ autoApprove: false });
    const pending = h.call({ method: "DELETE", path: "/api/me/themes/rename-during-hold" });
    await vi.waitFor(
      () => expect(h.events.some((event) => event.kind === "action_request")).toBe(true),
      { timeout: 5_000 }
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    expect(card.details?.target).toBe("Approved original");
    expect(
      (
        await browser({
          method: "PUT",
          path: "/api/me/themes/rename-during-hold",
          body: { name: "Replacement target", tokens: themeTokens }
        })
      ).statusCode
    ).toBe(200);
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    await pending;
    expect(callSpy).not.toHaveBeenCalled();
    expect(
      (await browser({ method: "GET", path: "/api/me/themes" })).json<{
        custom: { id: string; name: string }[];
      }>().custom
    ).toContainEqual(
      expect.objectContaining({ id: "rename-during-hold", name: "Replacement target" })
    );
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });
});
