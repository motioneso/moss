import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AccessContext, AiAssistantActionRequest, DataContextDb } from "@moss/db";
import { registerAiRoutes, type AiRoutesDependencies } from "../../packages/ai/src/routes.js";

const threadId = "62000000-0000-4000-8000-000000000001";

function harness(
  actorUserId: string,
  getActionRequestPresentation?: AiRoutesDependencies["getActionRequestPresentation"],
  recoverActionRequests?: (actorUserId: string) => Promise<void>,
  resolveActionRequest?: AiRoutesDependencies["resolveActionRequest"]
) {
  const scopedDb = {} as DataContextDb;
  const listAssistantActions = vi.fn(async (): Promise<AiAssistantActionRequest[]> => []);
  const withDataContext = vi.fn(
    async (_context: AccessContext, run: (db: DataContextDb) => Promise<unknown>) => run(scopedDb)
  );
  const dependencies = {
    resolveAccessContext: async () => ({ actorUserId, requestId: "request-1" }),
    dataContext: { withDataContext },
    resolveActiveModules: () => [],
    repository: { listAssistantActions },
    getActionRequestPresentation,
    recoverActionRequests,
    resolveActionRequest,
    secretCipher: { encryptJson: vi.fn(), decryptJson: vi.fn() }
  } as unknown as AiRoutesDependencies;
  const server = Fastify();
  registerAiRoutes(server, dependencies);
  return { server, scopedDb, listAssistantActions, withDataContext };
}

function pendingAction(id: string): AiAssistantActionRequest {
  return {
    id,
    owner_user_id: "user-a",
    chat_thread_id: threadId,
    outcome_recorded_at: null,
    outcome_ignored_at: null,
    chat_session_id: "session-a",
    expires_at: null,
    tool_module_id: "notes",
    tool_module_name: "Notes",
    tool_name: "notes.write_note",
    permission_id: "notes.write",
    risk: "write",
    status: "pending",
    input_summary: { text: id },
    request_id: null,
    requested_at: new Date(0),
    resolved_at: null,
    updated_at: new Date(0)
  };
}

describe("GET /api/ai/assistant-actions thread filter", () => {
  it("recovers only the authenticated owner's deadlines before reading chat cards", async () => {
    const recoverActionRequests = vi.fn(async () => {});
    const { server, listAssistantActions } = harness("user-a", undefined, recoverActionRequests);
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/ai/assistant-actions?threadId=${threadId}`
      });
      expect(response.statusCode).toBe(200);
      expect(recoverActionRequests).toHaveBeenCalledExactlyOnceWith("user-a");
      expect(recoverActionRequests.mock.invocationCallOrder[0]).toBeLessThan(
        listAssistantActions.mock.invocationCallOrder[0]!
      );
    } finally {
      await server.close();
    }
  });

  it("does not list cards if owner deadline recovery fails", async () => {
    const recoverActionRequests = vi.fn().mockRejectedValue(new Error("Recovery unavailable"));
    const { server, listAssistantActions } = harness("user-a", undefined, recoverActionRequests);
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/ai/assistant-actions?threadId=${threadId}`
      });
      expect(response.statusCode).toBe(500);
      expect(listAssistantActions).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("returns live disclosure and leaves incomplete pending cards declineable", async () => {
    const presentation = {
      summary: "Save note",
      outsideContentNotice: false,
      details: { target: "Note A", fields: [] }
    };
    const getActionRequestPresentation = vi.fn((owner: string, id: string) =>
      owner === "user-a" && id === "live" ? presentation : undefined
    );
    const { server, listAssistantActions } = harness("user-a", getActionRequestPresentation);
    listAssistantActions.mockResolvedValue([
      pendingAction("live"),
      pendingAction("orphan"),
      { ...pendingAction("terminal"), status: "timed_out" }
    ]);
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/ai/assistant-actions?threadId=${threadId}`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().actions).toEqual([
        expect.objectContaining({ id: "live", approvalAvailable: true, presentation }),
        expect.objectContaining({ id: "orphan", approvalAvailable: false })
      ]);
      expect(response.json().actions[1]).not.toHaveProperty("presentation");
      expect(getActionRequestPresentation).toHaveBeenCalledWith("user-a", "live");
      expect(getActionRequestPresentation).toHaveBeenCalledWith("user-a", "orphan");
    } finally {
      await server.close();
    }
  });

  it("disables restored approval when no live gateway is wired", async () => {
    const { server, listAssistantActions } = harness("user-a");
    listAssistantActions.mockResolvedValue([pendingAction("orphan")]);
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/ai/assistant-actions?threadId=${threadId}`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().actions).toEqual([
        expect.objectContaining({ id: "orphan", approvalAvailable: false })
      ]);
    } finally {
      await server.close();
    }
  });
  it.each(["user-a", "user-b"])(
    "passes the filter within %s's access context",
    async (actorUserId) => {
      const { server, scopedDb, listAssistantActions, withDataContext } = harness(actorUserId);
      try {
        const response = await server.inject({
          method: "GET",
          url: `/api/ai/assistant-actions?threadId=${threadId}`
        });
        expect(response.statusCode).toBe(200);
        expect(withDataContext).toHaveBeenCalledWith(
          { actorUserId, requestId: "request-1" },
          expect.any(Function)
        );
        expect(listAssistantActions).toHaveBeenCalledExactlyOnceWith(scopedDb, threadId);
      } finally {
        await server.close();
      }
    }
  );

  it("preserves the unfiltered owner activity list without a query", async () => {
    const { server, scopedDb, listAssistantActions } = harness("user-a");
    listAssistantActions.mockResolvedValue([pendingAction("orphan")]);
    try {
      const response = await server.inject({ method: "GET", url: "/api/ai/assistant-actions" });
      expect(response.statusCode).toBe(200);
      expect(response.json().actions.map((action: { id: string }) => action.id)).toEqual([
        "orphan"
      ]);
      expect(listAssistantActions).toHaveBeenCalledExactlyOnceWith(scopedDb, undefined);
    } finally {
      await server.close();
    }
  });

  it.each(["", "not-a-thread"])(
    'rejects invalid thread filter "%s" before listing',
    async (invalidThreadId) => {
      const { server, listAssistantActions } = harness("user-a");
      try {
        const response = await server.inject({
          method: "GET",
          url: `/api/ai/assistant-actions?threadId=${invalidThreadId}`
        });
        expect(response.statusCode).toBe(400);
        expect(listAssistantActions).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    }
  );
});

it("keeps unavailable disclosure distinct from timed-out through the AI resolve schema", async () => {
  const resolve = vi.fn(async () => "unavailable" as const);
  const h = harness("owner", undefined, undefined, resolve);
  try {
    const response = await h.server.inject({
      method: "POST",
      url: "/api/ai/assistant-actions/62000000-0000-4000-8000-000000000002/resolve",
      payload: { status: "confirmed" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("approval_unavailable");
    expect(resolve).toHaveBeenCalledWith(
      "owner",
      "62000000-0000-4000-8000-000000000002",
      "confirmed"
    );
  } finally {
    await h.server.close();
  }
});
