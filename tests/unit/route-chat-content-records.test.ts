import { describe, expect, it, vi } from "vitest";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { AppActionsService } from "../../packages/chat/src/app-actions.js";
import { makeAppActionGateway } from "../fixtures/app-actions-gateway.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog,
  matchChatBlockedPathRule
} from "../../packages/module-registry/src/route-catalog.js";
import {
  MEETING_CAPTURE_NAMED_BLOCKED,
  RECORDS_EXPECTED_ROWS,
  RECORDS_MODULE_IDS,
  RECORDS_NAMED_BLOCKED
} from "../fixtures/route-chat-content-records.js";

const manifests = () => getBuiltInModuleManifests().filter((m) => RECORDS_MODULE_IDS.has(m.id));
const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000001");

// Offline boundary proof: the production catalog, resolver, gateway and approval flow
// are unchanged. Only persistence and HTTP dispatch are in-memory stand-ins.
function actionHarness(yoloMode = false, tainted = false, meetingAvailable = true) {
  // Approval now resolves the owner-scoped target through the real repository. A successful
  // rename needs an existing record; an empty persistence fixture correctly refuses it.
  const { scoped, queries } = makeRecordingDb({
    rows: meetingAvailable
      ? [
          {
            id: "00000000-0000-4000-8000-000000000001",
            title: "Untitled meeting",
            personal_notes: "",
            notes_revision: 0,
            created_at: new Date("2026-10-08T00:00:00Z"),
            updated_at: new Date("2026-10-08T00:00:00Z")
          }
        ]
      : []
  });
  const runner = {
    withDataContext: async <T>(_actor: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
      work(scoped)
  } as DataContextRunner;
  const call = vi
    .fn<AppActionsService["call"]>()
    .mockResolvedValue({ status: 200, body: { ok: true } });
  return {
    ...makeAppActionGateway({
      runner,
      appActions: { catalog: () => buildRouteCatalog(getBuiltInModuleManifests(), []), call },
      provenance: {
        isTainted: async () => tainted,
        recordAdmission: async () => undefined,
        runAutomatic: async (_actor, _thread, run) => ({ kind: "ran", value: await run() })
      },
      yoloMode,
      autoApprove: false
    }),
    callSpy: call,
    queries
  };
}

describe("record, mail and weather chat policies", () => {
  it("classifies every route explicitly", () => {
    expect(() => assertRouteChatClassification(manifests())).not.toThrow();
    const catalog = buildRouteCatalog(manifests(), []);
    const rows = catalog.routes.map((route) =>
      [
        route.moduleId,
        route.method,
        route.path,
        route.policy.access,
        route.policy.blockedBecause,
        route.policy.content === "user_authored" ? "user_authored" : undefined,
        route.policy.outbound ? "outbound" : undefined
      ]
        .filter(Boolean)
        .join(" ")
    );
    expect(rows.sort()).toEqual([...RECORDS_EXPECTED_ROWS].sort());
  });
  it.each(RECORDS_NAMED_BLOCKED)("blocks %s %s as %s", (method, path, category) => {
    const found = buildRouteCatalog(manifests(), []).resolve(method, concrete(path));
    expect(found?.route.path).toBe(path);
    expect(found?.route.policy).toMatchObject({ access: "blocked", blockedBecause: category });
  });
  it("names the exact meeting or project being deleted", () => {
    for (const path of ["/api/meetings/records/:id", "/api/workshop/projects/:projectId"]) {
      const found = buildRouteCatalog(manifests(), []).resolve("DELETE", concrete(path));
      expect(found?.route.policy).toMatchObject({
        access: "destructive",
        target: expect.any(Function)
      });
    }
  });
  it("keeps saved notes, transcripts, project context and mail outside", () => {
    const catalog = buildRouteCatalog(manifests(), []);
    for (const [method, path] of [
      ["PUT", "/api/meetings/records/:id/notes"],
      ["GET", "/api/meetings/records/:id/transcript"],
      ["PATCH", "/api/workshop/projects/:projectId"],
      ["GET", "/api/email/messages/:id"]
    ]) {
      expect(catalog.resolve(method!, concrete(path!))?.route.policy.content).toBe("outside");
    }
  });

  it.each(MEETING_CAPTURE_NAMED_BLOCKED)(
    "explicitly blocks capture in the manifest: %s %s",
    (method, path, category) => {
      const meeting = manifests().find((manifest) => manifest.id === "meetings")!;
      const route = meeting.routes?.find((route) => route.method === method && route.path === path);
      expect(route?.chat).toMatchObject({ access: "blocked", blockedBecause: category });
    }
  );

  it.each(MEETING_CAPTURE_NAMED_BLOCKED)(
    "refuses capture before approval, persistence or dispatch: %s %s",
    async (method, path) => {
      const h = actionHarness(true);
      expect(await h.call({ method, path: concrete(path) })).toMatchObject({
        ok: false,
        denied: true,
        reason: expect.stringMatching(/^blocked(?::|$)/)
      });
      expect(h.events).toEqual([]);
      expect(h.callSpy).not.toHaveBeenCalled();
      expect(h.queries).toEqual([]);
      expect(h.repository.createPendingAssistantAction).not.toHaveBeenCalled();
      expect(h.repository.insertActionAuditLog).not.toHaveBeenCalled();
      expect(h.repository.resolveAssistantAction).not.toHaveBeenCalled();
    }
  );

  it("keeps device linking, unlinking and recording authority outside app actions", () => {
    const catalog = buildRouteCatalog(getBuiltInModuleManifests(), []);
    for (const [method, path] of [
      ["POST", "/api/companion/pair"],
      ["POST", "/api/companion/pair/attempt"],
      ["POST", "/api/companion/pair/decide"],
      ["POST", "/api/companion/pair/redeem"],
      ["POST", "/api/companion/pair/cancel"],
      ["PATCH", "/api/companion/device"],
      ["POST", "/api/companion/logout"],
      ["POST", "/api/companion/recording-capability/attempt"],
      ["POST", "/api/companion/recording-capability/status"],
      ["GET", "/api/companion/recording-capabilities"],
      ["POST", "/api/companion/recording-capability/decide"],
      ["POST", "/api/companion/recording-capability/revoke"]
    ] as const) {
      expect(matchChatBlockedPathRule(method, path)?.category).toBe("identity_auth_registration");
      expect(catalog.resolve(method, path)).toBeNull();
    }
  });

  it("classifies rename as an ordinary write and availability as a read", () => {
    const catalog = buildRouteCatalog(manifests(), []);
    expect(
      catalog.resolve("PUT", concrete("/api/meetings/records/:id/title"))?.route.policy
    ).toMatchObject({ access: "write", title: "Rename your meeting", content: "user_authored" });
    expect(catalog.resolve("GET", "/api/meetings/output-availability")?.route.policy).toMatchObject(
      { access: "read", content: "outside" }
    );
  });

  it.each([false, true])(
    "runs an ordinary rename in a clean conversation (YOLO=%s)",
    async (yoloMode) => {
      const h = actionHarness(yoloMode);
      const input = {
        method: "PUT" as const,
        path: concrete("/api/meetings/records/:id/title"),
        body: { title: "Weekly planning", expectedTitle: "Untitled meeting" }
      };
      expect(await h.call(input)).toMatchObject({ ok: true });
      expect(h.events.filter((event) => event.kind === "action_request")).toEqual([]);
      expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(input, expect.anything());
    }
  );

  it("requires rename approval when the conversation is tainted", async () => {
    const h = actionHarness(false, true);
    const input = {
      method: "PUT" as const,
      path: concrete("/api/meetings/records/:id/title"),
      body: { title: "Weekly planning", expectedTitle: "Untitled meeting" }
    };
    const pending = h.call(input);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    expect(card).toMatchObject({
      summary: "Rename your meeting",
      details: {
        presentation: "human",
        target: "Untitled meeting",
        fields: [
          { label: "New title", value: "Weekly planning" },
          { label: "Current title", value: "Untitled meeting" }
        ]
      }
    });
    expect(h.callSpy).not.toHaveBeenCalled();
    h.confirmations.resolve(card.actionRequestId, "confirmed");
    expect(await pending).toMatchObject({ ok: true });
    expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(input, expect.anything());
  });

  it("renames without a card in a tainted conversation under YOLO", async () => {
    const h = actionHarness(true, true);
    const input = {
      method: "PUT" as const,
      path: concrete("/api/meetings/records/:id/title"),
      body: { title: "Weekly planning", expectedTitle: "Untitled meeting" }
    };
    expect(await h.call(input)).toMatchObject({ ok: true });
    expect(h.events.filter((event) => event.kind === "action_request")).toEqual([]);
    expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(input, expect.anything());
  });

  it("does not rename when tainted-call approval is rejected", async () => {
    const h = actionHarness(false, true);
    const pending = h.call({
      method: "PUT",
      path: concrete("/api/meetings/records/:id/title"),
      body: { title: "Weekly planning", expectedTitle: "Untitled meeting" }
    });
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
    );
    const card = h.events.find((event) => event.kind === "action_request")!;
    h.confirmations.resolve(card.actionRequestId, "rejected");
    expect(await pending).toMatchObject({ ok: false });
    expect(h.callSpy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses rename when the owner-scoped target is unavailable (tainted=%s)",
    async (tainted) => {
      const h = actionHarness(false, tainted, false);
      expect(
        await h.call({
          method: "PUT",
          path: concrete("/api/meetings/records/:id/title"),
          body: { title: "Weekly planning", expectedTitle: "Untitled meeting" }
        })
      ).toMatchObject({ ok: false, denied: true });
      expect(h.events.filter((event) => event.kind === "action_request")).toEqual([]);
      expect(h.callSpy).not.toHaveBeenCalled();
      expect(h.queries).toContainEqual(
        expect.objectContaining({
          sql: expect.stringContaining('from "app"."meeting_records"'),
          parameters: ["00000000-0000-4000-8000-000000000001"]
        })
      );
    }
  );

  it("reads output availability without approval or an output-generation call", async () => {
    const h = actionHarness();
    const input = { method: "GET" as const, path: "/api/meetings/output-availability" };
    expect(await h.call(input)).toMatchObject({ ok: true });
    expect(h.events.filter((event) => event.kind === "action_request")).toEqual([]);
    expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(input, expect.anything());
  });
});
