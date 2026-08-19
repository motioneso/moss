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
  readonly chunks?: readonly Record<string, unknown>[];
}) {
  const execute = vi.fn().mockResolvedValue({ data: { chunks: input.chunks ?? [] } });
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
    readToolTrustBoundary: createNotesReadToolTrustBoundary({
      threads: { getCurrentThread: vi.fn().mockResolvedValue({ incognito: input.incognito }) },
      memorySettings: {
        getOrCreate: vi.fn().mockResolvedValue({ recallEnabled: input.recallEnabled })
      }
    })
  });
  const token = tokens.mint({
    actorUserId: ACTOR,
    chatSessionId: surfaceSessionKey(ACTOR),
    allowedToolNames: new Set(["notes.search"])
  });
  return { execute, gateway, token, tokens };
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
