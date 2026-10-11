import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScriptedClaudeAcp } from "../uat/fixtures/scripted-provider/claude-main.js";
import { loadChatScriptFixture } from "../uat/fixtures/scripted-provider/script-schema.js";
import { UAT_CHAT_SCRIPTS } from "../uat/seed/types.js";
import {
  APP_ACTION_PROMPT,
  APP_ACTION_REPLY,
  APP_ACTION_THEME,
  APP_ACTION_THEME_PATH,
  themePutEvidence
} from "../uat/specs/app-actions-fixture.js";

const readline = vi.hoisted(() => ({ createInterface: vi.fn() }));
vi.mock("node:readline", () => readline);

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function readFrames(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("#3065 scripted ACP provider fixture", () => {
  const originalArgv = process.argv;
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.stubEnv("JARVIS_UAT_SEED_CHAT_SCRIPT", "3065-app-actions");
    process.argv = [
      "node",
      "claude-entry.ts",
      "--session-id",
      "fixture-session",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          moss: {
            url: "http://127.0.0.1:41999/api/mcp",
            headers: { Authorization: "Bearer fixture-token" }
          }
        }
      })
    ];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    readline.createInterface.mockReturnValue(
      (async function* () {
        yield JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: APP_ACTION_PROMPT }] }
        });
      })()
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers one fixed provider decision matching the browser fixture and named theme", () => {
    expect(UAT_CHAT_SCRIPTS).toContain("3065-app-actions");
    const script = loadChatScriptFixture("3065-app-actions");
    expect(script.turns).toEqual([
      {
        expectIncludes: [APP_ACTION_PROMPT],
        calls: [
          { tool: "app.findAction", arguments: { query: "Switch your theme" } },
          {
            tool: "app.callAction",
            arguments: {
              method: "PUT",
              path: APP_ACTION_THEME_PATH,
              body: { id: APP_ACTION_THEME.id }
            }
          }
        ],
        reply: APP_ACTION_REPLY
      }
    ]);
  });

  function mockMcp(action: () => Promise<Response>) {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        method: string;
        params: { name?: string };
      };
      if (request.method === "initialize") return rpcResponse({ protocolVersion: "2024-11-05" });
      if (request.method === "tools/list") {
        return rpcResponse({ tools: [{ name: "app.findAction" }, { name: "app.callAction" }] });
      }
      if (request.params.name === "app.callAction") return action();
      return rpcResponse({ isError: false, content: [{ type: "text", text: "catalog fixture" }] });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("waits for the held MCP action before emitting the scripted success reply", async () => {
    let resolveAction!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      resolveAction = resolve;
    });
    const fetch = mockMcp(() => held);
    const run = runScriptedClaudeAcp();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    const before = readFrames(output);
    expect(before.some((frame) => frame.type === "result")).toBe(false);
    expect(JSON.stringify(before)).not.toContain(APP_ACTION_REPLY);
    expect(JSON.stringify(before)).toContain("mcp__moss__app_callAction");
    resolveAction(
      rpcResponse({ isError: false, content: [{ type: "text", text: "saved fixture" }] })
    );
    await run;
    const requests = fetch.mock.calls.map(
      ([, init]) => JSON.parse(String(init.body)) as { method: string; params: unknown }
    );
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "tools/list",
      "tools/call",
      "tools/call"
    ]);
    expect(requests.at(-1)?.params).toEqual({
      name: "app.callAction",
      arguments: { method: "PUT", path: APP_ACTION_THEME_PATH, body: { id: APP_ACTION_THEME.id } }
    });
    expect(readFrames(output).filter((frame) => frame.type === "result")).toEqual([
      expect.objectContaining({ subtype: "success", result: APP_ACTION_REPLY, is_error: false })
    ]);
  });

  it("cannot emit a successful theme reply when the real gateway denies or fails the call", async () => {
    mockMcp(async () =>
      rpcResponse({ isError: true, content: [{ type: "text", text: "not approved" }] })
    );
    await expect(runScriptedClaudeAcp()).rejects.toThrow("acp-mcp-tools-call-denied-or-failed");
    expect(readFrames(output).some((frame) => frame.type === "result")).toBe(false);
    expect(JSON.stringify(output)).not.toContain(APP_ACTION_REPLY);
  });

  it("cannot emit success if the MCP transport fails", async () => {
    mockMcp(async () => new Response("unavailable", { status: 503 }));
    await expect(runScriptedClaudeAcp()).rejects.toThrow("acp-mcp-tools-call-http-503");
    expect(readFrames(output).some((frame) => frame.type === "result")).toBe(false);
    expect(JSON.stringify(output)).not.toContain(APP_ACTION_REPLY);
  });
});

describe("#3065 real server theme PUT evidence", () => {
  it("counts real Fastify injected requests once, separately from completions and theme setup", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      }
    });
    const server = Fastify({ logger: { stream } });
    server.put(APP_ACTION_THEME_PATH, async () => ({ activeId: APP_ACTION_THEME.id }));
    server.put(`/api/me/themes/${APP_ACTION_THEME.id}`, async () => ({ theme: APP_ACTION_THEME }));
    server.get("/api/me/themes", async () => ({ activeId: APP_ACTION_THEME.id }));
    try {
      await server.inject({ method: "PUT", url: `/api/me/themes/${APP_ACTION_THEME.id}` });
      await server.inject({ method: "GET", url: "/api/me/themes" });
      expect(themePutEvidence(lines.join(""))).toEqual([]);
      await server.inject({ method: "PUT", url: APP_ACTION_THEME_PATH });
      expect(themePutEvidence(lines.join(""))).toEqual([
        {
          requestId: expect.any(String),
          method: "PUT",
          path: APP_ACTION_THEME_PATH,
          statusCode: 200
        }
      ]);
      // Duplicate-dispatch negative control: another actual route request cannot be hidden.
      await server.inject({ method: "PUT", url: APP_ACTION_THEME_PATH });
      expect(themePutEvidence(lines.join(""))).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("reads Compose-prefixed JSON but never turns a logged URL mention into a request", () => {
    const incoming = {
      reqId: "one",
      msg: "incoming request",
      req: { method: "PUT", url: APP_ACTION_THEME_PATH }
    };
    const complete = { reqId: "one", msg: "request completed", res: { statusCode: 200 } };
    const log = [
      `jarv1s-1 | ${JSON.stringify(incoming)}`,
      `jarv1s-1 | ${JSON.stringify(complete)}`,
      JSON.stringify({ msg: `PUT ${APP_ACTION_THEME_PATH}` }),
      "incomplete {",
      JSON.stringify({ ...incoming, req: { method: "GET", url: APP_ACTION_THEME_PATH } }),
      JSON.stringify({ ...incoming, req: { method: "PUT", url: `${APP_ACTION_THEME_PATH}/extra` } })
    ].join("\n");
    expect(themePutEvidence(log)).toEqual([
      { requestId: "one", method: "PUT", path: APP_ACTION_THEME_PATH, statusCode: 200 }
    ]);
  });

  it("does not label an incomplete or failed write successful", () => {
    const incoming = JSON.stringify({
      reqId: "one",
      msg: "incoming request",
      req: { method: "PUT", url: APP_ACTION_THEME_PATH }
    });
    expect(themePutEvidence(incoming)[0]?.statusCode).toBeNull();
    const complete = JSON.stringify({
      reqId: "one",
      msg: "request completed",
      res: { statusCode: 403 }
    });
    expect(themePutEvidence(`${incoming}\n${complete}`)[0]?.statusCode).toBe(403);
    expect(themePutEvidence(complete)).toEqual([]);
  });
});
