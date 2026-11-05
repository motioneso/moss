import { describe, expect, it } from "vitest";
import type { AcpTunnel } from "@moss/acp";
import { createAcpNoToolsStructuredAdapterFactory } from "./acp-structured-adapter.js";

class FakeTunnel implements AcpTunnel {
  readonly spawns: Array<{ profile: string }> = [];
  replies: string[] = ['{"overview":"ok"}'];
  /** What the fake Claude session reports about itself; `undefined` sends no report. */
  initReport: unknown = {
    type: "system",
    subtype: "init",
    tools: [],
    mcp_servers: [],
    plugins: []
  };
  /** Every prompt text the agent received, in order. */
  readonly prompts: string[] = [];
  private readonly outbox: string[] = [];
  private seq = 0;
  async spawn(_key: string, _project: string, _kind: string, _user: string, profile: string) {
    this.spawns.push({ profile });
    return { cwd: "/tmp/work", home: "/tmp/work/.private-home", pid: 1, uid: 1, gid: 1 };
  }
  async send(_key: string, line: string): Promise<void> {
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
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      this.prompts.push(
        (JSON.parse(line) as { params?: { prompt?: { text?: string }[] } }).params?.prompt?.[0]
          ?.text ?? ""
      );
      if (this.initReport !== undefined)
        this.emit({
          jsonrpc: "2.0",
          method: "_claude/sdkMessage",
          params: { sessionId: "s1", message: this.initReport }
        });
      const text = this.replies.shift() ?? '{"overview":"ok"}';
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
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

const input = {
  service: "module.meetings" as never,
  model: { provider_kind: "anthropic" as const, provider_model_id: "claude-test" },
  messages: [{ role: "user" as const, content: "Summarise this meeting." }],
  schema: { type: "object", properties: { overview: { type: "string" } } },
  maxOutputTokens: 8192,
  actorUserId: "user-1",
  acpAgentId: "claude-acp"
};

describe("ACP no-tools structured adapter", () => {
  it("runs the prompt through the no-tools profile and returns raw JSON text", async () => {
    const tunnel = new FakeTunnel();
    const adapter = createAcpNoToolsStructuredAdapterFactory(() => tunnel)("anthropic");
    await expect(adapter.generateStructured(input)).resolves.toMatchObject({
      rawText: '{"overview":"ok"}'
    });
    expect(tunnel.spawns).toEqual([{ profile: "no-tools" }]);
    // The fixed check sentence goes first, then the real prompt.
    expect(tunnel.prompts[0]).toBe("Reply with the single word OK.");
    expect(tunnel.prompts).toHaveLength(2);
  });

  it.each([
    ["a tool", { tools: ["Read"] }, "violation", "tools"],
    ["a connector server", { mcp_servers: [{ name: "x" }] }, "violation", "tools"],
    ["a plugin", { plugins: [{ name: "p" }] }, "violation", "setting_sources"]
  ])(
    "stops before any transcript is sent when the session reports %s",
    async (_name, extra, cause, property) => {
      const tunnel = new FakeTunnel();
      tunnel.initReport = {
        type: "system",
        subtype: "init",
        tools: [],
        mcp_servers: [],
        plugins: [],
        ...extra
      };
      const adapter = createAcpNoToolsStructuredAdapterFactory(() => tunnel)("anthropic");
      await expect(adapter.generateStructured(input)).rejects.toMatchObject({
        name: "StructuredIsolationFailedError",
        isolationCause: cause,
        property
      });
      expect(tunnel.prompts).toEqual(["Reply with the single word OK."]);
      expect(tunnel.prompts.join("\n")).not.toContain("Summarise this meeting.");
    }
  );

  it.each([
    ["no report", undefined],
    ["a junk report", "garbage"],
    ["a report with no tool list", { type: "system", subtype: "init" }]
  ])("stops with could not verify when the session gives %s", async (_name, report) => {
    const tunnel = new FakeTunnel();
    tunnel.initReport = report;
    const adapter = createAcpNoToolsStructuredAdapterFactory(() => tunnel)("anthropic");
    await expect(adapter.generateStructured(input)).rejects.toMatchObject({
      name: "StructuredIsolationFailedError",
      isolationCause: "unverifiable"
    });
    expect(tunnel.prompts).toEqual(["Reply with the single word OK."]);
  });

  it("stops only the failing run, so the next good run succeeds", async () => {
    const bad = new FakeTunnel();
    bad.initReport = {
      type: "system",
      subtype: "init",
      tools: ["Bash"],
      mcp_servers: [],
      plugins: []
    };
    const good = new FakeTunnel();
    const tunnels = [bad, good];
    const adapter = createAcpNoToolsStructuredAdapterFactory(() => tunnels.shift())("anthropic");
    await expect(adapter.generateStructured(input)).rejects.toThrow();
    await expect(adapter.generateStructured(input)).resolves.toMatchObject({
      rawText: '{"overview":"ok"}'
    });
  });

  it("refuses a provider with no ACP no-tools route", async () => {
    const tunnel = new FakeTunnel();
    const adapter = createAcpNoToolsStructuredAdapterFactory(() => tunnel)("google" as never);
    await expect(
      adapter.generateStructured({
        ...input,
        model: { provider_kind: "google" as never, provider_model_id: "g" }
      })
    ).rejects.toThrow(/Structured transport is unavailable/);
  });

  it("refuses when no runner tunnel is available", async () => {
    const adapter = createAcpNoToolsStructuredAdapterFactory(() => undefined)("anthropic");
    await expect(adapter.generateStructured(input)).rejects.toThrow(/unavailable/);
  });
});
