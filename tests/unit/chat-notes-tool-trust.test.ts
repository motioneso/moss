import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { ModuleAssistantToolManifest } from "@moss/module-sdk";
import { notesSearchResponseSchema } from "@moss/shared";
import { createNotesReadToolTrustBoundary } from "../../packages/chat/src/live/notes-tool-trust.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";

const ACTOR = "00000000-0000-4000-8000-000000000001";

function makeGateway(input: {
  readonly incognito: boolean;
  readonly recallEnabled: boolean;
  readonly threadOwner?: string;
  readonly chunks?: readonly Record<string, unknown>[];
}) {
  const execute = vi.fn().mockResolvedValue({ data: { chunks: input.chunks ?? [] } });
  const recordAdmission = vi.fn(async () => undefined);
  const tool: ModuleAssistantToolManifest = {
    name: "notes.search",
    description: "Search notes",
    permissionId: "notes.search",
    risk: "read",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } }
    },
    outputSchema: notesSearchResponseSchema,
    externalContent: true,
    execute
  };
  const tokens = new SessionTokenRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [
      {
        id: "notes",
        name: "Notes",
        version: "0.1.0",
        publisher: "jarv1s",
        lifecycle: "required",
        compatibility: { jarv1s: ">=0.0.0" },
        availability: { defaultEnabled: true, required: true },
        database: { migrations: [], migrationDirectories: [], ownedTables: [] },
        assistantTools: [tool]
      }
    ],
    repository: {} as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: never) => unknown) => work({} as never)
    } as never,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: vi.fn() },
    confirmTimeoutMs: 5_000,
    provenance: {
      isTainted: async () => false,
      recordAdmission
    },
    readToolTrustBoundary: createNotesReadToolTrustBoundary({
      threads: {
        getThreadById: vi.fn().mockResolvedValue({
          owner_user_id: input.threadOwner ?? ACTOR,
          surface: "drawer",
          incognito: input.incognito
        })
      },
      memorySettings: {
        getOrCreate: vi.fn().mockResolvedValue({ recallEnabled: input.recallEnabled })
      }
    })
  });
  const token = tokens.mint({
    actorUserId: ACTOR,
    threadId: "00000000-0000-4000-8000-000000000002",
    chatSessionId: surfaceSessionKey(ACTOR),
    allowedToolNames: new Set(["notes.search"])
  });
  return { execute, gateway, token, tokens, recordAdmission };
}

describe("notes.search model-context trust boundary", () => {
  it.each([
    ["incognito", true, true],
    ["recall disabled", false, false]
  ])("does not read notes when %s", async (_label, incognito, recallEnabled) => {
    const { execute, gateway, token } = makeGateway({ incognito, recallEnabled });

    const result = await gateway.callTool(token, "notes.search", { query: "launch" });

    expect(result.ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('"chunks":[]');
  });

  it("drops credential-shaped chunks before the MCP result reaches model context", async () => {
    const credential = ["g", "hp_", "definitely-not-a-real-credential"].join("");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { gateway, token, tokens } = makeGateway({
      incognito: false,
      recallEnabled: true,
      chunks: [
        { sourcePath: "safe.md", lineStart: 1, lineEnd: 1, text: "Launch snack: kumquat" },
        { sourcePath: "private.md", lineStart: 1, lineEnd: 1, text: credential }
      ]
    });

    const app = Fastify({ logger: false });
    registerMcpTransportRoute(app, { gateway, tokens });
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${token}` },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "notes.search", arguments: { query: "launch" } }
      }
    });
    const rendered = response.body;

    expect(response.statusCode).toBe(200);
    expect(rendered).toContain('"isError":false');
    expect(rendered).toContain("kumquat");
    expect(rendered).not.toContain(credential);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
    await app.close();
    warn.mockRestore();
  });
});

describe("notes privacy follows the captured turn identity", () => {
  function boundary(
    thread: { owner_user_id: string; surface: string; incognito: boolean } | undefined
  ) {
    const getThreadById = vi.fn().mockResolvedValue(thread);
    const getCurrentThread = vi.fn().mockResolvedValue({
      owner_user_id: ACTOR,
      surface: "drawer",
      incognito: !thread?.incognito
    });
    const execute = vi.fn(async () => ({
      data: { chunks: [{ sourcePath: "note.md", text: "Safe note" }] }
    }));
    const threads = { getThreadById, getCurrentThread };
    const trust = createNotesReadToolTrustBoundary({
      threads,
      memorySettings: { getOrCreate: vi.fn().mockResolvedValue({ recallEnabled: true }) }
    });
    const call = (
      threadId: string | undefined = "thread-a",
      chatSessionId = surfaceSessionKey(ACTOR)
    ) =>
      trust({
        scopedDb: {} as never,
        toolName: "notes.search",
        ctx: {
          actorUserId: ACTOR,
          requestId: "test",
          chatSessionId,
          ...(threadId ? { threadId } : {})
        },
        execute
      });
    return { call, execute, getThreadById, getCurrentThread };
  }

  it("denies private A after switching the selected conversation to ordinary B", async () => {
    const h = boundary({ owner_user_id: ACTOR, surface: "drawer", incognito: true });
    expect(await h.call()).toEqual({ data: { chunks: [] } });
    expect(h.getThreadById).toHaveBeenCalledWith(expect.anything(), "thread-a", "drawer");
    expect(h.getCurrentThread).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("allows ordinary bound A independently of the currently selected private B", async () => {
    const h = boundary({ owner_user_id: ACTOR, surface: "drawer", incognito: false });
    expect(await h.call()).toEqual({
      data: { chunks: [{ sourcePath: "note.md", text: "Safe note" }] }
    });
    expect(h.getCurrentThread).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing thread", undefined],
    ["foreign thread", { owner_user_id: "other", surface: "drawer", incognito: false }],
    ["wrong surface", { owner_user_id: ACTOR, surface: "workshop", incognito: false }]
  ] as const)("denies %s without calling the notes handler", async (_label, thread) => {
    const h = boundary(thread);
    expect(await h.call()).toEqual({ data: { chunks: [] } });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing binding", "", surfaceSessionKey(ACTOR)],
    ["foreign session", "thread-a", surfaceSessionKey("other")],
    ["invalid session", "thread-a", "invalid"]
  ])("denies %s before retrieving notes or thread state", async (_label, threadId, session) => {
    const h = boundary({ owner_user_id: ACTOR, surface: "drawer", incognito: false });
    expect(await h.call(threadId, session)).toEqual({ data: { chunks: [] } });
    expect(h.getThreadById).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("bound cross-tool gateway notes reads", () => {
  it.each([true, false])(
    "carries the bound private=%s decision through runReadToolForActor",
    async (incognito) => {
      const h = makeGateway({
        incognito,
        recallEnabled: true,
        chunks: [
          { sourcePath: "note.md", lineStart: 1, lineEnd: 1, text: "Cross-tool note marker" }
        ]
      });
      const result = await h.gateway.runReadToolForActor(
        ACTOR,
        "notes.search",
        { query: "launch" },
        { threadId: "thread-a", chatSessionId: surfaceSessionKey(ACTOR) }
      );
      expect(result.ok).toBe(true);
      if (incognito) {
        expect(h.execute).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain("Cross-tool note marker");
      } else {
        expect(h.execute).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).toContain("Cross-tool note marker");
      }
      // Collection is not model exposure: only a nonempty admitted normalized block taints.
      expect(h.recordAdmission).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing binding", undefined, ACTOR],
    [
      "foreign session",
      { threadId: "thread-a", chatSessionId: surfaceSessionKey("foreign") },
      ACTOR
    ],
    ["foreign thread", { threadId: "thread-a", chatSessionId: surfaceSessionKey(ACTOR) }, "foreign"]
  ] as const)(
    "keeps %s from retrieving notes through the cross-tool gateway",
    async (_label, binding, threadOwner) => {
      const h = makeGateway({ incognito: false, recallEnabled: true, threadOwner });
      const result = await h.gateway.runReadToolForActor(
        ACTOR,
        "notes.search",
        { query: "launch" },
        binding
      );
      expect(result.ok).toBe(true);
      expect(h.execute).not.toHaveBeenCalled();
    }
  );
});
