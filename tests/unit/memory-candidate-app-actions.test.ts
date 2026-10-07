import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";

import type { AppActionsService } from "../../packages/chat/src/app-actions.js";
import { appActionCatalog, makeAppActionGateway } from "../fixtures/app-actions-gateway.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

/**
 * #3065, Ben 2026-10-06: Moss may list the user's own pending memory suggestions and accept one,
 * with an approval card on every accept. Persistence and HTTP transport are fakes; the real
 * catalog, memory manifest, target resolver, gateway policy and confirmation flow run unchanged.
 */

const CANDIDATE_ID = "66666666-6666-4666-8666-666666666666";
const ACCEPT = {
  method: "POST",
  path: `/api/memory/candidates/${CANDIDATE_ID}/accept`
} as const;
const pendingRow = {
  id: CANDIDATE_ID,
  payload_json: { manualRequest: true, excerpt: "I take the 7:40 train on Tuesdays" }
};

function harness(options: { rows?: Record<string, unknown>[] } = {}) {
  const { scoped, queries } = makeRecordingDb({ rows: options.rows ?? [pendingRow] });
  const runner = {
    withDataContext: async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
      work(scoped)
  } as DataContextRunner;
  const call = vi
    .fn<AppActionsService["call"]>()
    .mockResolvedValue({ status: 200, body: { accepted: true } });
  const appActions: AppActionsService = { catalog: () => appActionCatalog, call };
  const gateway = makeAppActionGateway({
    runner,
    appActions,
    provenance: {
      isTainted: async () => false,
      recordAdmission: async () => undefined,
      runAutomatic: async (_actor, _thread, run) => ({ kind: "ran", value: await run() })
    },
    // YOLO on a clean conversation is the most permissive policy; accept must still ask.
    yoloMode: true,
    autoApprove: false
  });
  return { ...gateway, callSpy: call, queries };
}

async function waitForCard(h: ReturnType<typeof harness>) {
  await vi.waitFor(() =>
    expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
  );
  return h.events.find((event) => event.kind === "action_request")!;
}

describe("memory suggestions through app actions", () => {
  it("classes accept destructive so it asks even under YOLO", () => {
    const route = appActionCatalog.resolve("POST", ACCEPT.path)?.route;
    expect(route?.moduleId).toBe("memory");
    expect(route?.policy.access).toBe("destructive");
    expect(route?.policy.target).toBeTypeOf("function");
  });

  it("lists pending suggestions as a read without an approval card", async () => {
    const h = harness();
    const result = await h.call({ method: "GET", path: "/api/memory/candidates" });
    expect(result).toMatchObject({ ok: true });
    expect(h.events.filter((event) => event.kind === "action_request")).toEqual([]);
    expect(h.callSpy).toHaveBeenCalledWith(
      { method: "GET", path: "/api/memory/candidates" },
      expect.anything()
    );
  });

  it("forwards the next page cursor through app.callAction without an approval card", async () => {
    const h = harness();
    const input = {
      method: "GET",
      path: "/api/memory/candidates",
      query: { cursor: `2026-10-06T12:00:00.123456Z_${CANDIDATE_ID}` }
    } as const;
    expect(await h.call(input)).toMatchObject({ ok: true });
    expect(h.callSpy).toHaveBeenCalledExactlyOnceWith(input, expect.anything());
    expect(h.events.filter((event) => event.kind === "action_request")).toEqual([]);
  });

  it("shows a card naming the suggestion and accepts only after approval", async () => {
    const h = harness();
    const pending = h.call(ACCEPT);
    const card = await waitForCard(h);
    expect(card).toMatchObject({
      summary: "Accept memory suggestion",
      details: { target: `I take the 7:40 train on Tuesdays [suggestion ${CANDIDATE_ID}]` }
    });
    expect(h.callSpy).not.toHaveBeenCalled();

    h.confirmations.resolve(card.actionRequestId, "confirmed");
    expect(await pending).toMatchObject({ ok: true });
    expect(h.callSpy).toHaveBeenCalledOnce();
    expect(h.callSpy).toHaveBeenCalledWith(ACCEPT, expect.anything());
  });

  it("does nothing when the accept card is rejected", async () => {
    const h = harness();
    const pending = h.call(ACCEPT);
    const card = await waitForCard(h);
    h.confirmations.resolve(card.actionRequestId, "rejected");
    expect(await pending).toMatchObject({ ok: false });
    expect(h.callSpy).not.toHaveBeenCalled();
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });

  it("refuses a suggestion that is not the actor's pending record before any card", async () => {
    const h = harness({ rows: [] });
    expect(await h.call(ACCEPT)).toMatchObject({
      ok: false,
      denied: true,
      reason: expect.stringMatching(/^unknown_route/)
    });
    expect(h.events).toEqual([]);
    expect(h.callSpy).not.toHaveBeenCalled();
    const lookup = h.queries.find((query) => query.sql.includes("app.memory_candidates"));
    expect(lookup?.sql).toContain("owner_user_id = app.current_actor_user_id()");
    expect(lookup?.sql).toContain("status = 'pending'");
  });
});
