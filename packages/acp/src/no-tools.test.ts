import { describe, expect, it } from "vitest";

import { MossAcpClient } from "./client.js";
import { checkAcpProfile } from "./capabilities.js";
import {
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

  it("requires all three Claude protections", () => {
    expect(() =>
      assertClaudeNoToolsOptions({ tools: [], settingSources: [], persistSession: false })
    ).not.toThrow();
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
      persistSession: false
    });
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
    ).rejects.toThrow(/offered tools/);
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
