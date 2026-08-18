// tests/integration/uat-scripted-claude.test.ts
//
// #1121 Task 3: proves claude-main.ts's contract with the real MCP HTTP transport — the same
// registerMcpTransportRoute + AssistantToolGateway + ConfirmationRegistry stack the live server
// runs, reached over a real listening socket via claude-main.ts's own fetch() calls (not
// server.inject, since that's not what the fixture executable does). loadChatScriptFixture is
// mocked to inject controlled turns without touching the real, shared phase1-smoke.json fixture
// or expanding UAT_CHAT_SCRIPTS (both shared-checkout state other sessions may depend on) —
// resolveCaptures/extractCapture and the schema types stay real.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  transcriptGlobDir,
  type GatewaySessionRecord
} from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { exampleToolCalls, exampleToolModule } from "./fixtures/example-tool-module.js";

import { loadChatScriptFixture } from "../uat/fixtures/scripted-provider/script-schema.js";
import type * as ScriptSchemaModule from "../uat/fixtures/scripted-provider/script-schema.js";
import { readCursor } from "../uat/fixtures/scripted-provider/session-state.js";
import {
  runScriptedClaude,
  main,
  SUCCESS_LOG_PATH
} from "../uat/fixtures/scripted-provider/claude-main.js";

vi.mock("../uat/fixtures/scripted-provider/script-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScriptSchemaModule>();
  return { ...actual, loadChatScriptFixture: vi.fn() };
});

// #1659: appendFileSync's own ESM export isn't configurable, so vi.spyOn can't wrap it directly
// (only vi.mock can substitute a module's binding) — wrap with vi.fn(actual) so every call still
// goes through to the real implementation while staying observable for the SUCCESS_LOG_PATH test.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

const READ_MCP_NAME = "mcp__jarvis__example_read";
const WRITE_MCP_NAME = "mcp__jarvis__example_write";

describe("scripted claude fixture executable (#1121 Task 3)", () => {
  let appDb: Kysely<MossDatabase>;
  let app: FastifyInstance;
  let tokens: SessionTokenRegistry;
  let gateway: AssistantToolGateway;
  let emitted: { chatSessionId: string; record: GatewaySessionRecord }[];
  let origin: string;
  let homeBase: string;
  let cwd: string;
  let originalArgv: readonly string[];
  let originalCwdSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalEnv: {
    JARVIS_UAT_SEED_CHAT_SCRIPT: string | undefined;
    JARVIS_CLI_HOME_BASE: string | undefined;
  };

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    const runner = new DataContextRunner(appDb);
    const repository = new AiRepository();

    tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    emitted = [];

    gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 5_000
    });

    app = Fastify({ logger: false });
    registerMcpTransportRoute(app, { gateway, tokens });
    await app.ready();
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await appDb.destroy();
  });

  beforeEach(() => {
    exampleToolCalls.length = 0;
    emitted.length = 0;
    cwd = mkdtempSync(join(tmpdir(), "uat-scripted-claude-cwd-"));
    homeBase = mkdtempSync(join(tmpdir(), "uat-scripted-claude-home-"));
    originalCwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    originalArgv = process.argv;
    originalEnv = {
      JARVIS_UAT_SEED_CHAT_SCRIPT: process.env.JARVIS_UAT_SEED_CHAT_SCRIPT,
      JARVIS_CLI_HOME_BASE: process.env.JARVIS_CLI_HOME_BASE
    };
    process.env.JARVIS_UAT_SEED_CHAT_SCRIPT = "phase1-smoke";
    process.env.JARVIS_CLI_HOME_BASE = homeBase;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    originalCwdSpy?.mockRestore();
    process.argv = [...originalArgv];
    if (originalEnv.JARVIS_UAT_SEED_CHAT_SCRIPT === undefined) {
      delete process.env.JARVIS_UAT_SEED_CHAT_SCRIPT;
    } else {
      process.env.JARVIS_UAT_SEED_CHAT_SCRIPT = originalEnv.JARVIS_UAT_SEED_CHAT_SCRIPT;
    }
    if (originalEnv.JARVIS_CLI_HOME_BASE === undefined) {
      delete process.env.JARVIS_CLI_HOME_BASE;
    } else {
      process.env.JARVIS_CLI_HOME_BASE = originalEnv.JARVIS_CLI_HOME_BASE;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeBase, { recursive: true, force: true });
    vi.mocked(loadChatScriptFixture).mockReset();
  });

  function writeMcpConfig(allowedTools: readonly string[]): {
    configPath: string;
    sessionId: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "uat-scripted-claude-mcp-"));
    const sessionId = randomUUID();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: randomUUID(),
      allowedToolNames: null
    });
    const configPath = join(dir, "mcp-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          jarvis: {
            url: new URL("/api/mcp", origin).toString(),
            headers: { Authorization: `Bearer ${token}` }
          }
        }
      }),
      "utf8"
    );
    return { configPath, sessionId };
  }

  function buildArgv(opts: {
    sessionId: string;
    configPath: string;
    allowedTools: readonly string[];
    promptText: string;
  }): string[] {
    return [
      "node",
      "bin/claude",
      "-p",
      "--session-id",
      opts.sessionId,
      "--permission-mode",
      "dontAsk",
      "--mcp-config",
      opts.configPath,
      "--settings",
      "/dev/null",
      "--allowedTools",
      opts.allowedTools.join(" "),
      "--append-system-prompt-file",
      "/dev/null",
      "--strict-mcp-config",
      opts.promptText
    ];
  }

  it("(a) valid bounded call: appends the transcript, writes the cursor, exits 0", async () => {
    vi.mocked(loadChatScriptFixture).mockReturnValue({
      version: 1,
      turns: [
        {
          expectIncludes: ["run-a"],
          calls: [{ tool: "example.read", arguments: { value: "hello-a" } }],
          reply: "reply-a"
        }
      ]
    });
    const { configPath, sessionId } = writeMcpConfig(["mcp__jarvis__*"]);
    process.argv = buildArgv({
      sessionId,
      configPath,
      allowedTools: ["mcp__jarvis__*"],
      promptText: "please run-a now"
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    main();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exampleToolCalls).toHaveLength(1);
    expect(exampleToolCalls[0]).toMatchObject({
      name: "example.read",
      input: { value: "hello-a" }
    });

    const transcriptPath = join(
      transcriptGlobDir("anthropic", cwd, homeBase),
      `${sessionId}.jsonl`
    );
    const lines = readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].message.content[0]).toMatchObject({ type: "tool_use", name: READ_MCP_NAME });
    expect(lines[1].message).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "reply-a" }]
    });

    const stateDir = join(cwd, ".uat-chat-script-state");
    expect(readCursor(stateDir, sessionId)).toEqual({
      scriptId: "phase1-smoke",
      turnIndex: 0,
      captures: {}
    });
  });

  it("(b) undeclared/out-of-pattern tool fails before tools/call is issued", async () => {
    vi.mocked(loadChatScriptFixture).mockReturnValue({
      version: 1,
      turns: [
        {
          expectIncludes: ["run-b"],
          calls: [{ tool: "example.write", arguments: { value: "should-not-be-called" } }],
          reply: "reply-b"
        }
      ]
    });
    const { configPath, sessionId } = writeMcpConfig(["mcp__jarvis__example_read"]);
    process.argv = buildArgv({
      sessionId,
      configPath,
      allowedTools: ["mcp__jarvis__example_read"],
      promptText: "please run-b now"
    });

    await expect(runScriptedClaude()).rejects.toThrow(/tool-not-allowed/);
    expect(exampleToolCalls).toHaveLength(0);

    const transcriptPath = join(
      transcriptGlobDir("anthropic", cwd, homeBase),
      `${sessionId}.jsonl`
    );
    expect(existsSync(transcriptPath)).toBe(false);
  });

  it("(c) confirmation-required write stays unmutated until approved, then completes", async () => {
    vi.mocked(loadChatScriptFixture).mockReturnValue({
      version: 1,
      turns: [
        {
          expectIncludes: ["run-c"],
          calls: [{ tool: "example.write", arguments: { value: "confirm-me-c" } }],
          reply: "reply-c"
        }
      ]
    });
    const { configPath, sessionId } = writeMcpConfig(["mcp__jarvis__*"]);
    process.argv = buildArgv({
      sessionId,
      configPath,
      allowedTools: ["mcp__jarvis__*"],
      promptText: "please run-c now"
    });

    const pending = runScriptedClaude();

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({ record: expect.objectContaining({ kind: "action_request" }) })
      );
    });
    const req = emitted.find((e) => e.record.kind === "action_request")?.record;
    if (!req || req.kind !== "action_request") throw new Error("expected action_request");
    expect(req.toolName).toBe("example.write");

    // Unmutated while pending: handler hasn't run and no transcript exists yet.
    expect(exampleToolCalls).toHaveLength(0);
    const transcriptPath = join(
      transcriptGlobDir("anthropic", cwd, homeBase),
      `${sessionId}.jsonl`
    );
    expect(existsSync(transcriptPath)).toBe(false);

    await gateway.resolveActionRequest(ids.userA, req.actionRequestId, "confirmed");
    await pending;

    expect(exampleToolCalls).toHaveLength(1);
    expect(exampleToolCalls[0]).toMatchObject({
      name: "example.write",
      input: { value: "confirm-me-c" }
    });
    const lines = readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].message.content[0]).toMatchObject({ type: "tool_use", name: WRITE_MCP_NAME });
  });

  it("(d) no sensitive content reaches stderr on a failure path", async () => {
    vi.mocked(loadChatScriptFixture).mockReturnValue({
      version: 1,
      turns: [
        {
          expectIncludes: ["run-d"],
          calls: [{ tool: "example.write", arguments: { value: "top-secret-argument-value" } }],
          reply: "reply-d"
        }
      ]
    });
    const { configPath, sessionId } = writeMcpConfig(["mcp__jarvis__example_read"]);
    const token = readFileSync(configPath, "utf8");
    const bearerMatch = /Bearer (\S+)"/.exec(token);
    const bearerToken = bearerMatch?.[1];
    expect(bearerToken).toBeDefined();

    process.argv = buildArgv({
      sessionId,
      configPath,
      allowedTools: ["mcp__jarvis__example_read"],
      promptText: "please run-d now"
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    main();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written).toContain("tool-not-allowed");
    expect(written).not.toContain("top-secret-argument-value");
    expect(written).not.toContain(bearerToken as string);
    expect(written).not.toContain(origin);
    expect(exampleToolCalls).toHaveLength(0);
  });

  it("(e) successful turn appends a success marker without prompt/reply content", async () => {
    vi.mocked(loadChatScriptFixture).mockReturnValue({
      version: 1,
      turns: [
        {
          expectIncludes: ["run-e"],
          calls: [],
          reply: "top-secret-reply-e"
        }
      ]
    });
    const { configPath, sessionId } = writeMcpConfig(["mcp__jarvis__*"]);
    process.argv = buildArgv({
      sessionId,
      configPath,
      allowedTools: ["mcp__jarvis__*"],
      promptText: "please run-e now"
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const appendSpy = vi.mocked(fsModule.appendFileSync);
    appendSpy.mockClear();

    main();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(exitSpy).toHaveBeenCalledWith(0);
    const successCall = appendSpy.mock.calls.find(([path]) => path === SUCCESS_LOG_PATH);
    expect(successCall).toBeDefined();
    const line = String(successCall?.[1]);
    expect(line).toContain("phase1-smoke");
    expect(line).not.toContain("please run-e now");
    expect(line).not.toContain("top-secret-reply-e");
  });
});
