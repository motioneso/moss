import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type AdmissionPath,
  type ConversationProvenancePort,
  type GatewaySessionRecord
} from "@moss/ai";
import {
  registerMcpTransportRoute,
  registerNativePermissionRoute,
  registerVaultReadReportRoute
} from "../../packages/chat/src/mcp-transport.js";
import {
  CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE,
  CLAUDE_PERMISSION_HOOK_SOURCE
} from "../../packages/chat/src/live/persistent-claude-permission-hook.js";
import type { MossModuleManifest } from "@moss/module-sdk";
import { runClaudeNativeHook } from "../fixtures/claude-native-hook.js";

const hooks = [
  ["persistent", CLAUDE_PERMISSION_HOOK_SOURCE],
  ["one-shot", CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE]
] as const;
const validReport = {
  toolName: "Read",
  toolInput: { file_path: "/synthetic/a.md" },
  cwd: "/synthetic"
};
const failure = { error: "Vault read admission failed closed." };

async function harness(modules: readonly MossModuleManifest[] = [], yolo = true) {
  let now = 0;
  const tokens = new SessionTokenRegistry({ clock: { now: () => now }, ttlMs: 1000 });
  const token = tokens.mint({
    actorUserId: "actor-a",
    chatSessionId: "session-a",
    threadId: "thread-a",
    allowedToolNames: null
  });
  const admissions: Array<{ actor: string; thread: string; path: AdmissionPath }> = [];
  let reserved = false;
  const owned = (actor: string, thread: string | undefined) =>
    actor === "actor-a" && thread === "thread-a";
  const tainted = (actor: string, thread: string | undefined) =>
    !owned(actor, thread) ||
    admissions.some((entry) => entry.actor === actor && entry.thread === thread);
  const recordAdmission = vi.fn(async (actor: string, thread: string, path: AdmissionPath) => {
    if (reserved || !owned(actor, thread)) throw new Error("Admission unavailable");
    admissions.push({ actor, thread, path });
  });
  const provenance: ConversationProvenancePort = {
    recordAdmission,
    isTainted: async (actor, thread) => tainted(actor, thread),
    isMarked: async (actor, thread) => owned(actor, thread) && tainted(actor, thread) && !reserved,
    async runAutomatic(actor, thread, execute) {
      if (reserved || tainted(actor, thread)) return { kind: "confirm" };
      reserved = true;
      try {
        return { kind: "ran", value: await execute() };
      } finally {
        reserved = false;
      }
    }
  };
  const confirmations = new ConfirmationRegistry();
  const records: GatewaySessionRecord[] = [];
  const gateway = new AssistantToolGateway({
    tokens,
    confirmations,
    resolveActiveModules: async () => modules,
    repository: {
      createPendingAssistantAction: async () => ({ id: "pending-a" }),
      resolveAssistantAction: async () => ({ id: "pending-a", status: "confirmed" }),
      insertActionAuditLog: async () => undefined
    } as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => unknown) => work({})
    } as never,
    notifier: { emit: (_session, record) => records.push(record) },
    confirmTimeoutMs: 1000,
    yoloMode: async () => yolo,
    provenance
  });
  const app = Fastify({ logger: false });
  registerMcpTransportRoute(app, { gateway, tokens });
  registerVaultReadReportRoute(app, { gateway, tokens });
  registerNativePermissionRoute(app, { gateway, tokens });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const root = await mkdtemp(join(tmpdir(), "moss-synthetic-vault-"));
  await writeFile(join(root, "fixture.md"), "Synthetic content. The hook never opens this file.");
  return {
    app,
    gateway,
    tokens,
    token,
    recordAdmission,
    admissions,
    records,
    confirmations,
    root,
    baseUrl,
    expire: () => {
      now = 1000;
    },
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("native vault read report route", () => {
  it("uses token actor/thread, ignores forged body identity and returns 204 only after admission", async () => {
    const h = await harness();
    let release!: () => void;
    const recorded = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.recordAdmission.mockImplementationOnce(async () => recorded);
    try {
      let completed = false;
      const response = h.app
        .inject({
          method: "POST",
          url: "/internal/vault-read-report",
          headers: { authorization: `Bearer ${h.token}` },
          body: { ...validReport, actorUserId: "forged-actor", threadId: "forged-thread" }
        })
        .then((result) => {
          completed = true;
          return result;
        });
      await vi.waitFor(() =>
        expect(h.recordAdmission).toHaveBeenCalledWith("actor-a", "thread-a", "native_vault_read")
      );
      expect(completed).toBe(false);
      release();
      const result = await response;
      expect(result.statusCode).toBe(204);
      expect(result.body).toBe("");
    } finally {
      release();
      await h.close();
    }
  });

  it.each([
    null,
    [],
    {},
    { ...validReport, toolName: "Write" },
    { ...validReport, toolInput: [] },
    { ...validReport, toolInput: {} },
    { ...validReport, cwd: null },
    { ...validReport, cwd: "relative" }
  ])("rejects invalid report body %j before recording", async (body) => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: "POST",
        url: "/internal/vault-read-report",
        headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
        payload: JSON.stringify(body)
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(failure);
      expect(h.recordAdmission).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it("returns a fixed response for malformed JSON without echoing its contents", async () => {
    const h = await harness();
    try {
      const result = await h.app.inject({
        method: "POST",
        url: "/internal/vault-read-report",
        headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
        payload: "private invalid contents"
      });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toEqual(failure);
      expect(h.recordAdmission).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it.each(["missing", "forged", "revoked", "expired", "unbound"])(
    "rejects %s token before recording",
    async (kind) => {
      const h = await harness();
      try {
        let token = h.token;
        if (kind === "forged") token = "jst_forged";
        if (kind === "revoked") h.tokens.revoke(token);
        if (kind === "expired") h.expire();
        if (kind === "unbound")
          token = h.tokens.mint({
            actorUserId: "actor-a",
            chatSessionId: "unbound",
            allowedToolNames: null
          });
        const response = await h.app.inject({
          method: "POST",
          url: "/internal/vault-read-report",
          headers: kind === "missing" ? {} : { authorization: `Bearer ${token}` },
          body: validReport
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(failure);
        expect(h.recordAdmission).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    }
  );
});

describe.each(hooks)("%s native hook admission", (_name, source) => {
  it.each(["Read", "Glob", "Grep"])(
    "reports %s before allowing, then a YOLO write asks",
    async (toolName) => {
      const h = await harness();
      try {
        const toolInput =
          toolName === "Read"
            ? { file_path: join(h.root, "fixture.md") }
            : { path: h.root, pattern: "*.md" };
        const result = await runClaudeNativeHook(
          source,
          { tool_name: toolName, tool_input: toolInput, cwd: h.root },
          h
        );
        expect(result).toMatchObject({ code: 0, permissionDecision: "allow", stderr: "" });
        expect(h.admissions).toEqual([
          { actor: "actor-a", thread: "thread-a", path: "native_vault_read" }
        ]);
        const write = runClaudeNativeHook(
          source,
          { tool_name: "Write", tool_input: { file_path: join(h.root, "output.md") }, cwd: h.root },
          h
        );
        await vi.waitFor(() =>
          expect(h.records).toContainEqual(
            expect.objectContaining({ kind: "action_request", outsideContentNotice: true })
          )
        );
        h.confirmations.resolve("pending-a", "rejected");
        expect((await write).permissionDecision).toBe("deny");
      } finally {
        await h.close();
      }
    }
  );

  it("a YOLO-off write after Read asks without naming outside content", async () => {
    const h = await harness([], false);
    try {
      await runClaudeNativeHook(
        source,
        { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
        h
      );
      const write = runClaudeNativeHook(
        source,
        { tool_name: "Write", tool_input: { file_path: join(h.root, "output.md") }, cwd: h.root },
        h
      );
      await vi.waitFor(() =>
        expect(h.records).toContainEqual(
          expect.objectContaining({ kind: "action_request", outsideContentNotice: false })
        )
      );
      h.confirmations.resolve("pending-a", "rejected");
      expect((await write).permissionDecision).toBe("deny");
    } finally {
      await h.close();
    }
  });

  it("does not allow while report persistence is pending", async () => {
    const h = await harness();
    let release!: () => void;
    h.recordAdmission.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    try {
      let completed = false;
      const result = runClaudeNativeHook(
        source,
        { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
        h
      ).then((value) => {
        completed = true;
        return value;
      });
      await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
      release();
      expect((await result).permissionDecision).toBe("allow");
    } finally {
      release?.();
      await h.close();
    }
  });

  it("denies on report failure without exposing the storage error", async () => {
    const h = await harness();
    h.recordAdmission.mockRejectedValueOnce(new Error("private file contents and token"));
    try {
      const result = await runClaudeNativeHook(
        source,
        { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
        h
      );
      expect(result).toMatchObject({
        code: 0,
        permissionDecision: "deny",
        permissionDecisionReason: "Vault read admission failed closed.",
        stderr: ""
      });
      expect(result.stdout).not.toContain("private file contents");
      expect(h.admissions).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it.each([200, 202, 302, 401, 500])(
    "denies a report response with unexpected status %s",
    async (status) => {
      const h = await harness();
      const transport = Fastify({ logger: false });
      transport.post("/internal/vault-read-report", (_request, reply) =>
        reply.code(status).send({ detail: "private report failure" })
      );
      const baseUrl = await transport.listen({ host: "127.0.0.1", port: 0 });
      try {
        const result = await runClaudeNativeHook(
          source,
          { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
          { ...h, baseUrl }
        );
        expect(result.permissionDecision).toBe("deny");
        expect(result.stdout).not.toContain("private report failure");
        expect(result.stderr).toBe("");
      } finally {
        await transport.close();
        await h.close();
      }
    }
  );

  it("denies without the token file, without making a report", async () => {
    const h = await harness();
    try {
      const result = await runClaudeNativeHook(
        source,
        { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
        { baseUrl: h.baseUrl, root: h.root }
      );
      expect(result).toMatchObject({ code: 0, permissionDecision: "deny", stderr: "" });
      expect(h.recordAdmission).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});

describe("persistent native fallback reads", () => {
  it.each(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Bash", "Task"])(
    "records approved %s admission before allowing output",
    async (toolName) => {
      const h = await harness();
      try {
        const result = runClaudeNativeHook(
          CLAUDE_PERMISSION_HOOK_SOURCE,
          {
            tool_name: toolName,
            tool_input: {
              file_path: "/synthetic-outside/file.md",
              path: "/synthetic-outside",
              pattern: "*.md",
              url: "https://example.test",
              query: "synthetic",
              command: "synthetic"
            },
            cwd: h.root
          },
          h
        );
        await vi.waitFor(() =>
          expect(h.records).toContainEqual(expect.objectContaining({ kind: "action_request" }))
        );
        h.confirmations.resolve("pending-a", "confirmed");
        expect((await result).permissionDecision).toBe("allow");
        expect(h.admissions).toContainEqual(
          expect.objectContaining({ actor: "actor-a", thread: "thread-a" })
        );
      } finally {
        await h.close();
      }
    }
  );
});

describe("one-shot workspace permission boundary", () => {
  it.each([
    ".jarvis-claude-permission-hook.mjs",
    ".jarvis-claude-settings.json",
    ".jarvis-claude-permission-token",
    ".jarvis-claude-mcp.json"
  ])("asks before rewriting authority file %s even when clean under YOLO", async (filename) => {
    const h = await harness();
    try {
      const write = runClaudeNativeHook(
        CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE,
        {
          tool_name: "Write",
          tool_input: { file_path: join(h.root, filename) },
          cwd: h.root
        },
        h
      );
      await vi.waitFor(() =>
        expect(h.records).toContainEqual(expect.objectContaining({ kind: "action_request" }))
      );
      h.confirmations.resolve("pending-a", "rejected");
      expect((await write).permissionDecision).toBe("deny");
      expect(h.recordAdmission).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it("retains a clean ordinary workspace write and conservatively admits its native output", async () => {
    const h = await harness();
    try {
      const write = await runClaudeNativeHook(
        CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE,
        {
          tool_name: "Write",
          tool_input: { file_path: join(h.root, "output.md") },
          cwd: h.root
        },
        h
      );
      expect(write.permissionDecision).toBe("allow");
      expect(h.records).not.toContainEqual(expect.objectContaining({ kind: "action_request" }));
      expect(h.recordAdmission).toHaveBeenCalledWith("actor-a", "thread-a", "native_tool_result");
    } finally {
      await h.close();
    }
  });
});

function descriptorModule(isExternal: boolean | undefined): MossModuleManifest {
  return {
    id: "descriptor-test",
    name: "Descriptor test",
    version: "1.0.0",
    publisher: "Synthetic test",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [
      {
        name: "descriptor-test.read",
        description: "Synthetic outside descriptor",
        permissionId: "descriptor-test.read",
        risk: "read",
        content: "outside",
        externalContent: true,
        ...(isExternal === undefined ? {} : { isExternal }),
        inputSchema: { type: "object", description: "Synthetic outside schema", properties: {} },
        execute: async () => ({ data: {} })
      }
    ]
  };
}

describe("gateway descriptor admission through MCP", () => {
  it.each([false, true, undefined])(
    "uses registry descriptor trust %s independently of result content",
    async (isExternal) => {
      // Production registry stamps built-ins false; integrations/external adapters stamp true.
      const h = await harness([descriptorModule(isExternal)]);
      try {
        const result = await h.app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: { authorization: `Bearer ${h.token}` },
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: { threadId: "forged-thread" }
          }
        });
        expect(result.json().result.tools).toEqual([
          expect.objectContaining({
            description: "Synthetic outside descriptor",
            inputSchema: expect.objectContaining({ description: "Synthetic outside schema" })
          })
        ]);
        if (isExternal === false) expect(h.recordAdmission).not.toHaveBeenCalled();
        else
          expect(h.admissions).toEqual([
            { actor: "actor-a", thread: "thread-a", path: "tool_external_descriptors" }
          ]);
        expect(h.tokens.getToolsListObservationCount(h.token)).toBe(1);
      } finally {
        await h.close();
      }
    }
  );

  it("withholds descriptions and input schemas when durable admission fails", async () => {
    const h = await harness([descriptorModule(true)]);
    h.recordAdmission.mockRejectedValueOnce(
      new Error("Synthetic outside descriptor storage error")
    );
    try {
      const result = await h.app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: { authorization: `Bearer ${h.token}` },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
      });
      expect(result.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" }
      });
      expect(result.body).not.toContain("Synthetic outside");
      expect(h.tokens.getToolsListObservationCount(h.token)).toBe(0);
    } finally {
      await h.close();
    }
  });
});

describe("MCP descriptor admission transport", () => {
  it("does not expose tool descriptors or mark readiness before session admission", async () => {
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint({
      actorUserId: "a",
      threadId: "thread-a",
      chatSessionId: "s",
      allowedToolNames: null
    });
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listToolsForSession = vi.fn(async () => {
      await admitted;
      return [
        {
          name: "remote.read",
          description: "remote descriptor",
          inputSchema: { type: "object", description: "remote schema" }
        }
      ];
    });
    const app = Fastify({ logger: false });
    registerMcpTransportRoute(app, { tokens, gateway: { listToolsForSession } as never });
    try {
      let completed = false;
      const response = app
        .inject({
          method: "POST",
          url: "/api/mcp",
          headers: { authorization: `Bearer ${token}` },
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
        })
        .then((result) => {
          completed = true;
          return result;
        });
      await vi.waitFor(() => expect(listToolsForSession).toHaveBeenCalledWith(token));
      expect(completed).toBe(false);
      expect(tokens.getToolsListObservationCount(token)).toBe(0);
      release();
      expect((await response).json().result.tools[0].description).toBe("remote descriptor");
      expect(tokens.getToolsListObservationCount(token)).toBe(1);
    } finally {
      release();
      await app.close();
    }
  });

  it("returns a fixed error without descriptors when admission fails", async () => {
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint({
      actorUserId: "a",
      threadId: "thread-a",
      chatSessionId: "s",
      allowedToolNames: null
    });
    const app = Fastify({ logger: false });
    registerMcpTransportRoute(app, {
      tokens,
      gateway: {
        listToolsForSession: async () => {
          throw new Error("private remote descriptor");
        }
      } as never
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: { authorization: `Bearer ${token}` },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
      });
      expect(response.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" }
      });
      expect(response.body).not.toContain("private remote");
      expect(tokens.getToolsListObservationCount(token)).toBe(0);
    } finally {
      await app.close();
    }
  });
});
