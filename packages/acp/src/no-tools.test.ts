import { describe, expect, it } from "vitest";

import { MossAcpClient } from "./client.js";
import { checkAcpProfile } from "./capabilities.js";
import {
  AcpIsolationError,
  evaluateClaudeIsolationReadback,
  assertClaudeNoToolsOptions,
  assertZeroToolsProof,
  codexNoToolsConfig
} from "./no-tools.js";
import { launchOffList } from "./tool-table.js";
import type { AcpTunnel } from "./tunnel.js";

describe("no-tools profile gate", () => {
  it("offers Claude and Codex and refuses Google and OpenCode with a reason", () => {
    expect(() => checkAcpProfile("no-tools", "anthropic")).not.toThrow();
    expect(() => checkAcpProfile("no-tools", "openai")).not.toThrow();
    expect(() => checkAcpProfile("no-tools", "google")).toThrow(/not been proven with tools off/);
    expect(() => checkAcpProfile("no-tools", "opencode")).toThrow(/not been proven with tools off/);
  });

  it("turns every known tool off", () => {
    const off = launchOffList("no-tools");
    expect(off).toContain("Read");
    expect(off).toContain("Bash");
    expect(off).toContain("Write");
    expect(off.length).toBeGreaterThan(20);
  });

  it("requires all four Claude protections", () => {
    expect(() =>
      assertClaudeNoToolsOptions({
        tools: [],
        settingSources: [],
        persistSession: false,
        strictMcpConfig: true
      })
    ).not.toThrow();
    expect(() =>
      assertClaudeNoToolsOptions({ tools: [], settingSources: [], persistSession: false })
    ).toThrow(/were not accepted/);
    expect(() => assertClaudeNoToolsOptions({ settingSources: [], persistSession: false })).toThrow(
      /were not accepted/
    );
    expect(() => assertClaudeNoToolsOptions({ tools: [], persistSession: false })).toThrow(
      /were not accepted/
    );
    expect(() => assertClaudeNoToolsOptions({ tools: [], settingSources: [] })).toThrow(
      /were not accepted/
    );
  });

  it("writes every Codex off switch", () => {
    const config = codexNoToolsConfig();
    for (const needle of [
      'web_search = "disabled"',
      "project_doc_max_bytes = 0",
      'persistence = "none"',
      "shell_tool = false",
      "[tools.experimental_request_user_input]",
      "[tools.update_plan]"
    ]) {
      expect(config).toContain(needle);
    }
  });

  it("blocks a call when a tool was seen", () => {
    expect(() =>
      assertZeroToolsProof({ providerKind: "anthropic", toolCallsSeen: 0 })
    ).not.toThrow();
    expect(() => assertZeroToolsProof({ providerKind: "anthropic", toolCallsSeen: 1 })).toThrow(
      /offered tools/
    );
  });
});

class SilentAgent implements AcpTunnel {
  readonly sent: string[] = [];
  private readonly outbox: string[] = [];
  private seq = 0;
  announceTool = false;
  announceAtOpen = false;
  /** What the fake session reports in its init message; `undefined` sends none. */
  initReport: unknown = {
    type: "system",
    subtype: "init",
    tools: [],
    mcp_servers: [],
    plugins: []
  };
  failProbe = false;
  readonly prompts: string[] = [];
  async spawn() {
    return { cwd: "/tmp/work", home: "/tmp/work/.private-home", pid: 1, uid: 1, gid: 1 };
  }
  async send(_key: string, line: string): Promise<void> {
    this.sent.push(line);
    const msg = JSON.parse(line) as { id?: number; method?: string };
    if (msg.method === "initialize") {
      this.emit({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: {}, mcpCapabilities: { http: false } }
        }
      });
    } else if (msg.method === "session/new") {
      if (this.announceAtOpen) {
        this.emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: { sessionUpdate: "tool_call", toolCallId: "c0", title: "Read" }
          }
        });
      }
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
    } else if (msg.method === "session/prompt") {
      this.prompts.push(
        (msg as { params?: { prompt?: { text?: string }[] } }).params?.prompt?.[0]?.text ?? ""
      );
      if (this.failProbe) {
        this.emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "boom" } });
        return;
      }
      if (this.initReport !== undefined) {
        this.emit({
          jsonrpc: "2.0",
          method: "_claude/sdkMessage",
          params: { sessionId: "s1", message: this.initReport }
        });
      }
      if (this.announceTool) {
        this.emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read" }
          }
        });
      }
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"ok":true}' }
          }
        }
      });
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
  async read(_key: string, afterSeq: number) {
    return {
      lines: this.outbox.slice(afterSeq),
      firstSeq: afterSeq + 1,
      nextSeq: this.seq,
      exited: false,
      truncated: false
    };
  }
  async kill(): Promise<void> {}
  async execStart() {
    return { execId: 1 };
  }
  async execPoll() {
    return { output: "", done: true, exitCode: 0, truncated: false, timedOut: false };
  }
  async execKill(): Promise<void> {}
  private emit(message: unknown): void {
    this.outbox.push(JSON.stringify(message));
    this.seq += 1;
  }
}

describe("MossAcpClient no-tools session", () => {
  it("sends the three Claude options and no tool server, and passes a silent agent", async () => {
    const agent = new SilentAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "summary:1",
      "summary",
      "anthropic",
      "user-1",
      "no-tools"
    );
    const opened = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "session/new");
    expect(opened.params.mcpServers).toEqual([]);
    expect(opened.params._meta.claudeCode.options).toMatchObject({
      tools: [],
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true
    });
    expect(opened.params._meta.claudeCode.emitRawSDKMessages).toEqual([
      { type: "system", subtype: "init" }
    ]);
    await expect(client.prompt(handle, "summarise")).resolves.toMatchObject({
      text: '{"ok":true}',
      toolCallsSeen: 0
    });
    await client.close(handle);
  });

  it("refuses a tool server before spawning", async () => {
    const agent = new SilentAgent();
    const client = new MossAcpClient(agent);
    await expect(
      client.openSession("summary:1", "summary", "anthropic", "user-1", "no-tools", {
        url: "http://moss.local/mcp",
        bearer: "x"
      })
    ).rejects.toThrow(/must not be attached/);
    expect(agent.sent).toHaveLength(0);
  });

  it("fails the open when the agent announces a tool call while opening", async () => {
    const agent = new SilentAgent();
    agent.announceAtOpen = true;
    const client = new MossAcpClient(agent);
    await expect(
      client.openSession("summary:1", "summary", "anthropic", "user-1", "no-tools")
    ).rejects.toMatchObject({ name: "AcpIsolationError", cause: "violation", property: "tools" });
  });

  it("fails the prompt when the agent announces a tool call", async () => {
    const agent = new SilentAgent();
    agent.announceTool = true;
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "summary:1",
      "summary",
      "anthropic",
      "user-1",
      "no-tools"
    );
    await expect(client.prompt(handle, "summarise")).rejects.toThrow(/offered tools/);
    await client.close(handle);
  });
});

describe("Claude isolation readback", () => {
  const open = async (agent: SilentAgent) => {
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "summary:1",
      "summary",
      "anthropic",
      "user-1",
      "no-tools"
    );
    return { client, handle };
  };
  const init = (extra: Record<string, unknown>) => ({
    type: "system",
    subtype: "init",
    tools: [],
    mcp_servers: [],
    plugins: [],
    ...extra
  });

  it("reports tools observed ok and the other two properties not observed", async () => {
    const agent = new SilentAgent();
    const { client, handle } = await open(agent);
    await expect(client.verifyIsolation(handle)).resolves.toEqual({
      tools: "observed_ok",
      settingSources: "not_observed",
      sessionPersistence: "not_observed"
    });
    // The probe is a fixed sentence, so no transcript can have gone out.
    expect(agent.prompts).toEqual(["Reply with the single word OK."]);
  });

  it.each([
    ["offers a tool", { tools: ["Read"] }, "tools"],
    ["offers a connector tool", { tools: ["mcp__claude_ai_Gmail__send_message"] }, "tools"],
    ["has an MCP server", { mcp_servers: [{ name: "x", status: "connected" }] }, "tools"],
    ["loads a plugin", { plugins: [{ name: "p", path: "/p" }] }, "setting_sources"]
  ])("stops when the session %s", async (_name, extra, property) => {
    const agent = new SilentAgent();
    agent.initReport = init(extra);
    const { client, handle } = await open(agent);
    await expect(client.verifyIsolation(handle)).rejects.toMatchObject({
      name: "AcpIsolationError",
      cause: "violation",
      property
    });
  });

  it("stops when a tool call shows up during the probe", async () => {
    const agent = new SilentAgent();
    agent.announceTool = true;
    const { client, handle } = await open(agent);
    await expect(client.verifyIsolation(handle)).rejects.toMatchObject({
      cause: "violation",
      property: "tools"
    });
  });

  it("does not accept a client that only echoes its own options", async () => {
    const agent = new SilentAgent();
    agent.initReport = undefined;
    const { client, handle } = await open(agent);
    await expect(client.verifyIsolation(handle)).rejects.toMatchObject({
      cause: "unverifiable",
      property: "readback"
    });
  });

  it("stops when the probe turn errors", async () => {
    const agent = new SilentAgent();
    agent.failProbe = true;
    const { client, handle } = await open(agent);
    await expect(client.verifyIsolation(handle)).rejects.toMatchObject({
      cause: "unverifiable"
    });
  });

  it.each([
    ["junk", "garbage"],
    ["wrong message kind", { type: "assistant", tools: [] }],
    ["tools not a list", init({ tools: "none" })],
    ["tools holds a non-string", init({ tools: [1] })],
    ["mcp_servers not a list", init({ mcp_servers: "none" })]
  ])("treats a %s report as unverifiable", (_name, report) => {
    expect(() => evaluateClaudeIsolationReadback(report)).toThrow(AcpIsolationError);
    try {
      evaluateClaudeIsolationReadback(report);
    } catch (error) {
      expect((error as AcpIsolationError).cause).toBe("unverifiable");
    }
  });

  it("refuses a readback on a session that is not a no-tools Claude session", async () => {
    const agent = new SilentAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession("s", "summary", "openai", "user-1", "no-tools");
    await expect(client.verifyIsolation(handle)).rejects.toMatchObject({ cause: "unverifiable" });
  });
});
