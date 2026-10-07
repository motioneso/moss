import { describe, expect, it, vi } from "vitest";

import {
  dataContextBrand,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import { HttpError, type ToolContext } from "@moss/module-sdk";
import { buildRouteCatalog } from "@moss/module-registry";

import {
  createAppActionCallServices,
  type AppActionCallInput,
  type AppActionsService
} from "../../packages/chat/src/app-actions.js";
import {
  aggregateConsentCalls,
  appActionCatalog,
  appActionContext,
  appActionManifests,
  blockedWellnessCalls,
  makeAppActionGateway,
  medicationSentinel,
  therapySentinel,
  themeTokens
} from "../fixtures/app-actions-gateway.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

/** Offline boundary proof only: preferences and HTTP transport are in-memory stand-ins.
 * The production consent callback, target resolver, route catalog, Settings tool execute,
 * gateway policy, confirmation flow, output cap and bound service execute unchanged.
 * Real SQL/RLS, Fastify validation and route writes are covered by the integration sibling.
 */
function harness(
  options: {
    consent?: boolean;
    ready?: boolean;
    autoApprove?: boolean;
    forceConfirm?: boolean;
    withoutPerCallWiring?: boolean;
    rejectNestedTransactions?: boolean;
  } = {}
) {
  const preferences = new Map<string, unknown>([
    ["wellness.ai_consent_granted", options.consent ?? true],
    [
      "themes.custom",
      [
        { id: "theme-a", name: "Server-read Forest", tokens: themeTokens },
        { id: "theme-b", name: "Server-read Ocean", tokens: themeTokens }
      ]
    ]
  ]);
  let activeScopes = 0;
  let scopeCount = 0;
  let maximumScopes = 0;
  const runner = {
    withDataContext: async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
      if (options.rejectNestedTransactions && activeScopes > 0) {
        throw new Error("Nested data transactions would starve a single-connection pool");
      }
      activeScopes += 1;
      scopeCount += 1;
      maximumScopes = Math.max(maximumScopes, activeScopes);
      const db = {
        selectFrom(table: string) {
          expect(["app.preferences", "app.instance_settings"]).toContain(table);
          let key = "";
          const query = {
            select: () => query,
            where(column: string, _operator: string, value: string) {
              expect(column).toBe("key");
              key = value;
              return query;
            },
            executeTakeFirst: async () =>
              table === "app.instance_settings" ? undefined : { value_json: preferences.get(key) }
          };
          return query;
        }
      };
      try {
        return await work({ db, [dataContextBrand]: true } as unknown as DataContextDb);
      } finally {
        activeScopes -= 1;
      }
    }
  } as DataContextRunner;
  const call = vi
    .fn<AppActionsService["call"]>()
    .mockResolvedValue({ status: 200, body: { ok: true } });
  const appActions: AppActionsService = {
    catalog: () => (options.ready === false ? null : appActionCatalog),
    call
  };
  return {
    ...makeAppActionGateway({
      runner,
      provenance: {
        isTainted: async () => false,
        recordAdmission: async () => undefined,
        runAutomatic: async (_actor, _thread, run) => ({ kind: "ran", value: await run() })
      },
      appActions,
      autoApprove: options.autoApprove,
      forceConfirm: options.forceConfirm,
      withoutPerCallWiring: options.withoutPerCallWiring
    }),
    callSpy: call,
    scopeCount: () => scopeCount,
    maximumScopes: () => maximumScopes,
    preferences
  };
}

function expectRefusal(result: unknown, reason: string) {
  expect(result).toMatchObject({
    ok: false,
    denied: true,
    reason: expect.stringMatching(new RegExp(`^${reason}(?:: |$)`))
  });
}

describe("app actions: real gateway/manifest boundary with fake persistence and transport", () => {
  it("blocks legacy chat-memory deletion before target lookup, approval or dispatch", async () => {
    const h = harness();
    const before = h.scopeCount();
    expectRefusal(
      await h.call({
        method: "DELETE",
        path: "/api/chat/memory/facts/11111111-1111-4111-8111-111111111111"
      }),
      "blocked"
    );
    expect(h.scopeCount()).toBe(before);
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    const route = appActionCatalog.resolve(
      "DELETE",
      "/api/chat/memory/facts/11111111-1111-4111-8111-111111111111"
    );
    expect(route?.route.policy.target).toBeUndefined();
    expect(route?.route.policy.coveredBy).toBe("memory.forget");
  });

  it("refuses the recording notice acknowledgement before any transport or approval", async () => {
    const meetings = appActionManifests.find((module) => module.id === "meetings")!;
    const catalog = buildRouteCatalog(
      [
        {
          ...meetings,
          routes: [
            {
              method: "PUT",
              path: "/api/meetings/recording-notice",
              permissionId: "meetings.view",
              chat: {
                access: "write",
                title: "Acknowledge recording notice",
                content: "user_authored"
              }
            }
          ]
        }
      ],
      []
    );
    const call = vi.fn<AppActionsService["call"]>().mockResolvedValue({ status: 200, body: {} });
    const h = makeAppActionGateway({
      runner: {} as DataContextRunner,
      appActions: { catalog: () => catalog, call }
    });
    expectRefusal(
      await h.call({
        method: "PUT",
        path: "/api/meetings/recording-notice",
        body: { policyVersion: "current" }
      }),
      "blocked"
    );
    expect(call).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it.each([
    ["blocked", "/api/me/profile", "PATCH"],
    ["unknown_route", "/api/not-a-real-route", "GET"],
    ["blocked", "/api/admin/users", "GET"]
  ] as const)("refuses %s before calling transport for %s", async (reason, path, method) => {
    const h = harness();
    expectRefusal(await h.call({ method, path }), reason);
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("fails closed on the production not_ready marker when per-call wiring is missing", async () => {
    const h = harness({ withoutPerCallWiring: true });
    const input = {
      method: "PUT" as const,
      path: "/api/me/weather-unit",
      body: { unit: "metric" }
    };
    const marker = h.dependencies.toolServices?.appActions as Pick<AppActionsService, "call">;
    await expect(marker.call(input, appActionContext)).rejects.toMatchObject({ code: "not_ready" });
    expect(await h.call(input)).toMatchObject({ ok: false });
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });

  it("runs an allowed app action with no unused outer or nested transaction", async () => {
    const h = harness({ rejectNestedTransactions: true });
    expect(await h.call({ method: "GET", path: "/api/me/themes" })).toMatchObject({ ok: true });
    expect(h.callSpy).toHaveBeenCalledTimes(1);
    // Initial resolution and immediate preflight each own their scope; transport has no outer scope.
    expect(h.scopeCount()).toBe(2);
    expect(h.maximumScopes()).toBe(1);
  });

  it("finds real catalog actions through the read-only gateway service without transport", async () => {
    const h = harness();
    expect(await h.find("custom theme")).toMatchObject({
      ok: true,
      structuredData: {
        actions: expect.arrayContaining([
          expect.objectContaining({
            method: "DELETE",
            path: "/api/me/themes/:id",
            access: "destructive"
          })
        ])
      }
    });
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("refuses not_ready while the route catalog holder is empty", async () => {
    const h = harness({ ready: false });
    expectRefusal(await h.call({ method: "GET", path: "/api/me/themes" }), "not_ready");
    expect(h.callSpy).not.toHaveBeenCalled();
  });

  it("refuses consent-off Wellness write without exposing the returned row", async () => {
    const h = harness({ consent: false });
    h.callSpy.mockResolvedValue({ status: 200, body: { checkin: { note: therapySentinel } } });
    const result = await h.call({ method: "PATCH", path: "/api/wellness/checkins/one", body: {} });
    expectRefusal(result, "consent_off");
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(therapySentinel);
  });

  it.each(blockedWellnessCalls())(
    "refuses every blocked Wellness route even with consent: $method $path",
    async (input) => {
      const h = harness({ consent: true });
      h.callSpy.mockResolvedValue({
        status: 200,
        body: { name: medicationSentinel, body: therapySentinel }
      });
      const result = await h.call(input);
      expectRefusal(result, "blocked");
      expect(h.callSpy).not.toHaveBeenCalled();
      expect(JSON.stringify([result, h.events])).not.toContain(medicationSentinel);
      expect(JSON.stringify([result, h.events])).not.toContain(therapySentinel);
    }
  );

  it.each(aggregateConsentCalls)(
    "refuses aggregate-consent alias before transport: $method $path",
    async (input) => {
      const h = harness({ consent: false });
      h.callSpy.mockResolvedValue({
        status: 200,
        body: { excerpt: therapySentinel, summary: medicationSentinel }
      });
      const result = await h.call(input);
      expectRefusal(result, "blocked");
      expect(h.callSpy).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(therapySentinel);
      expect(JSON.stringify(result)).not.toContain(medicationSentinel);
    }
  );

  it("looks up distinct theme names for two approval cards rather than echoing caller labels", async () => {
    const h = harness();
    await h.call({ method: "DELETE", path: "/api/me/themes/theme-a" });
    await h.call({ method: "DELETE", path: "/api/me/themes/theme-b" });
    const cards = h.events.filter((event) => event.kind === "action_request");
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.details?.target)).toEqual([
      "Server-read Forest",
      "Server-read Ocean"
    ]);
    expect(h.callSpy).toHaveBeenCalledTimes(2);
  });

  it("confirms a concrete memory fact PATCH with its actor-scoped SQL target and outside label", async () => {
    const id = "00000000-0000-4000-8000-000000000041";
    // Compiles the real target SQL, but returns a controlled row without simulating RLS.
    const recorded = makeRecordingDb({
      rows: [
        {
          id,
          subject_entity_id: appActionContext.actorUserId,
          subject_name: "User",
          predicate: "prefers",
          object_text: "dark mode",
          object_entity_id: null,
          object_name: null
        }
      ]
    });
    const call = vi
      .fn<AppActionsService["call"]>()
      .mockResolvedValue({ status: 200, body: { patched: true } });
    const runner = {
      withDataContext: async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work(recorded.scoped)
    } as DataContextRunner;
    const h = makeAppActionGateway({
      runner,
      appActions: { catalog: () => appActionCatalog, call },
      provenance: { isTainted: async () => false, recordAdmission: async () => undefined }
    });
    const input = {
      method: "PATCH" as const,
      path: `/api/memory/graph/facts/${id}`,
      body: { pinned: false }
    };
    try {
      expect(await h.resolver(input, appActionContext)).toMatchObject({
        kind: "proceed",
        risk: "destructive",
        forceConfirm: true,
        externalContent: true,
        details: { target: `User: prefers: dark mode` }
      });
      expect(await h.call(input)).toMatchObject({ ok: true });
      expect(h.events).toContainEqual(
        expect.objectContaining({
          kind: "action_request",
          details: expect.objectContaining({ target: `User: prefers: dark mode` })
        })
      );
      expect(call).toHaveBeenCalledTimes(1);
      expect(recorded.queries.length).toBeGreaterThan(0);
      for (const query of recorded.queries) {
        expect(query.sql).toContain("f.owner_user_id = app.current_actor_user_id()");
        expect(query.parameters).toEqual([id]);
      }
    } finally {
      await recorded.scoped.db.destroy();
    }
  });

  it("carries settings refresh scope and exact resolved fields after a write", async () => {
    const h = harness();
    expect(
      await h.call({ method: "PUT", path: "/api/me/weather-unit", body: { unit: "metric" } })
    ).toMatchObject({ ok: true });
    expect(
      await h.resolver(
        { method: "PUT", path: "/api/me/weather-unit", body: { unit: "metric" } },
        appActionContext
      )
    ).toMatchObject({
      kind: "proceed",
      details: { fields: expect.arrayContaining([{ label: "Body: unit", value: '"metric"' }]) }
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: "action_result",
        outcome: "executed",
        affectsModules: ["settings"]
      })
    );
  });

  it("reports a failed HTTP write without a success event or refresh scope", async () => {
    const h = harness();
    h.callSpy.mockResolvedValue({ status: 400, body: { error: "Invalid weather unit" } });
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
  });

  it("caps an oversized app response with the existing truncation note", async () => {
    const h = harness();
    h.callSpy.mockResolvedValue({
      status: 200,
      body: { text: "x".repeat(40_000), tail: "RESPONSE_TAIL_3071" }
    });
    const result = await h.call({ method: "GET", path: "/api/me/themes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain("[truncated tool result]");
    expect(String(result.data.text)).toHaveLength(16_000);
    expect(String(result.data.text)).not.toContain("RESPONSE_TAIL_3071");
  });

  it("classifies outbound weather search as a read that requires confirmation when tainted", async () => {
    const h = harness();
    expect(
      await h.resolver(
        { method: "GET", path: "/api/me/weather-location/search", query: { q: "Paris" } },
        appActionContext
      )
    ).toMatchObject({ kind: "proceed", risk: "read", confirmWhenTainted: true });
    expect(h.callSpy).not.toHaveBeenCalled();
  });

  it("rechecks consent after approval rather than using the pre-card decision", async () => {
    const h = harness({ autoApprove: false, forceConfirm: true });
    const pending = h.call({ method: "PATCH", path: "/api/wellness/checkins/one", body: {} });
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    h.preferences.set("wellness.ai_consent_granted", false);
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    const result = await pending;
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^consent_off:/) });
    expect(JSON.stringify(result)).toContain("Settings");
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });

  it("rechecks a server-read target after approval", async () => {
    const h = harness({ autoApprove: false });
    const pending = h.call({ method: "DELETE", path: "/api/me/themes/theme-a" });
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    h.preferences.set("themes.custom", [
      { id: "theme-a", name: "Replacement target", tokens: themeTokens }
    ]);
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^approval_changed:/)
    });
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });

  it("does not expose arbitrary transport HttpError text when safe refusals are enabled", async () => {
    const h = harness();
    h.callSpy.mockRejectedValueOnce(new HttpError(503, "PRIVATE_DEPENDENCY_SENTINEL"));
    const result = await h.call({ method: "GET", path: "/api/me/themes" });
    expect(result).toMatchObject({ ok: false, error: "Tool app.callAction failed" });
    expect(JSON.stringify([result, h.events])).not.toContain("PRIVATE_DEPENDENCY_SENTINEL");
  });

  it("returns not_ready with safe recovery when the final pre-run lookup throws", async () => {
    const h = harness({ autoApprove: false });
    const pending = h.call({ method: "DELETE", path: "/api/me/themes/theme-a" });
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    vi.spyOn(h.preferences, "get").mockImplementation(() => {
      throw new HttpError(503, "PRIVATE_FINAL_LOOKUP_SENTINEL");
    });
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^not_ready:/) });
    expect(JSON.stringify(result)).toContain("Wait");
    expect(JSON.stringify([result, h.events])).not.toContain("PRIVATE_FINAL_LOOKUP_SENTINEL");
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });

  it.each(["input", "context"] as const)(
    "does not let a bound execution service retarget %s",
    async (changed) => {
      const h = harness();
      const input = { method: "GET" as const, path: "/api/me/themes" };
      const resolution = await h.resolver(input, appActionContext);
      expect(resolution.kind).toBe("proceed");
      if (resolution.kind !== "proceed") return;
      const services = h.services(input, appActionContext, resolution);
      const ctx: ToolContext =
        changed === "context"
          ? { ...appActionContext, actorUserId: "another-user" }
          : appActionContext;
      const retargeted =
        changed === "input" ? { method: "DELETE" as const, path: "/api/me/themes/theme-a" } : input;
      await expect(services.appActions.call(retargeted, ctx)).rejects.toThrow(
        /^invalid_call_binding:/
      );
      expect(h.callSpy).not.toHaveBeenCalled();
    }
  );
  it("snapshots caller-owned input before the approval hold", async () => {
    const h = harness({ autoApprove: false, forceConfirm: true });
    const input = {
      method: "PUT" as const,
      path: "/api/me/weather-unit",
      body: { unit: "metric" }
    };
    const pending = h.call(input);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    input.path = "/api/me/profile";
    input.body.unit = "imperial";
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    expect(await pending).toMatchObject({ ok: true });
    expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(
      { method: "PUT", path: "/api/me/weather-unit", body: { unit: "metric" } },
      expect.objectContaining({ actorUserId: appActionContext.actorUserId })
    );
  });

  it("cannot retarget an initially equal mutable clone while preflight is awaiting", async () => {
    const h = harness();
    const input = Object.freeze({
      method: "PUT" as const,
      path: "/api/me/weather-unit",
      body: Object.freeze({ unit: "metric" })
    });
    const ctx = Object.freeze({ ...appActionContext });
    const resolution = await h.resolver(input, ctx);
    expect(resolution.kind).toBe("proceed");
    if (resolution.kind !== "proceed") return;
    let enterPreflight!: () => void;
    let finishPreflight!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterPreflight = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      finishPreflight = resolve;
    });
    const services = createAppActionCallServices({
      appActions: { catalog: () => appActionCatalog, call: h.callSpy },
      resolver: async () => {
        enterPreflight();
        await paused;
        return resolution;
      }
    })(input, ctx, resolution);
    const request = {
      method: "PUT" as AppActionCallInput["method"],
      path: "/api/me/weather-unit",
      body: { unit: "metric" }
    };
    const caller = { ...ctx };
    const pending = services.appActions.call(request, caller);
    await entered;
    request.method = "DELETE";
    request.path = "/api/me/themes/theme-b";
    request.body.unit = "imperial";
    caller.actorUserId = "another-user";
    finishPreflight();
    await pending;
    expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(input, ctx);
    expect(h.callSpy.mock.calls[0]?.[0]).not.toBe(request);
    expect(h.callSpy.mock.calls[0]?.[1]).not.toBe(caller);
  });

  it("allows a bound transport capability to be consumed only once", async () => {
    const h = harness();
    const input = { method: "GET" as const, path: "/api/me/themes" };
    const resolution = await h.resolver(input, appActionContext);
    expect(resolution.kind).toBe("proceed");
    if (resolution.kind !== "proceed") return;
    const services = h.services(input, appActionContext, resolution);
    await services.appActions.call(input, appActionContext);
    await expect(services.appActions.call(input, appActionContext)).rejects.toThrow(
      /^invalid_call_binding:/
    );
    expect(h.callSpy).toHaveBeenCalledTimes(1);
  });
});
