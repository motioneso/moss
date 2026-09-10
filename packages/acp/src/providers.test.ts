import { describe, expect, it } from "vitest";

import type { InitializeResponse } from "@agentclientprotocol/sdk";

import { MossAcpClient, acceptedOptionValues, findModelOption } from "./client.js";
import { AcpCapabilityError, checkAcpProfile, checkAgentCapabilities } from "./capabilities.js";
import { getAcpProviderRow, listAcpProviderRows } from "./providers.js";
import type { AcpTunnel } from "./tunnel.js";

function chatResponse(overrides: Partial<InitializeResponse> = {}): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true }
    },
    ...overrides
  } as InitializeResponse;
}

describe("provider rows", () => {
  it("holds one pinned row per provider kind", () => {
    expect(listAcpProviderRows()).toHaveLength(4);
    expect(getAcpProviderRow("anthropic").registry).toBe(
      "@agentclientprotocol/claude-agent-acp@0.75.1"
    );
    expect(getAcpProviderRow("openai").registry).toBe("@agentclientprotocol/codex-acp@1.10.0");
    expect(getAcpProviderRow("opencode").registry).toBe("opencode@1.18.29");
    expect(getAcpProviderRow("google").chatReady).toBe(false);
  });

  it("throws on an unknown provider kind", () => {
    expect(() => getAcpProviderRow("unknown" as never)).toThrow(/Unknown ACP provider kind/);
  });
});

describe("profile gate", () => {
  it("passes Claude for chat", () => {
    expect(() => checkAcpProfile("chat", "anthropic")).not.toThrow();
  });

  it("offers OpenCode for chat", () => {
    expect(() => checkAcpProfile("chat", "opencode")).not.toThrow();
  });

  it("offers Codex for chat when the runner hands off its login", () => {
    expect(() => checkAcpProfile("chat", "openai")).not.toThrow();
    expect(getAcpProviderRow("openai").model).toContain("CODEX_CONFIG");
  });

  it("rejects Google for chat with its reason", () => {
    expect(() => checkAcpProfile("chat", "google")).toThrow(AcpCapabilityError);
    expect(() => checkAcpProfile("chat", "google")).toThrow(/slice 2/);
  });

  it("rejects workshop and unattended with not built yet", () => {
    expect(() => checkAcpProfile("workshop", "anthropic")).toThrow(/not built yet/);
    expect(() => checkAcpProfile("unattended", "anthropic")).toThrow(/not built yet/);
  });

  it("opens a Codex chat session after the runner hands off its login", async () => {
    const agent = new ModelAgent(["m-1"]);
    const client = new MossAcpClient(agent);
    await expect(
      client.openSession("chat:user:conv", "conv", "openai", "user-1", "chat")
    ).resolves.toMatchObject({ sessionId: "agent-sess-1" });
    expect(agent.sent.some((line) => JSON.parse(line).method === "session/new")).toBe(true);
  });

  it("refuses to open a Workshop session before anything is spawned", async () => {
    const agent = new ModelAgent(["m-1"]);
    const client = new MossAcpClient(agent);
    await expect(
      client.openSession("workshop:user:proj", "proj", "anthropic", "user-1", "workshop")
    ).rejects.toThrow(/not built yet/);
    expect(agent.sent).toHaveLength(0);
  });

  it("fails closed on a newer protocol version for chat", () => {
    expect(() => checkAgentCapabilities("chat", chatResponse({ protocolVersion: 2 }))).toThrow(
      /pinned to version 1/
    );
  });
});

/**
 * Scripted agent that advertises a model option at session open and answers
 * the model switch. Records every line the client sends.
 */
class ModelAgent implements AcpTunnel {
  readonly sent: string[] = [];
  private readonly outbox: string[] = [];
  private seq = 0;

  constructor(private readonly modelValues: string[] | null = ["m-1", "m-2"]) {}

  async spawn(): Promise<{
    cwd: string;
    home: string | null;
    pid: number | null;
    uid: number;
    gid: number;
  }> {
    return {
      cwd: "/runner/session/acp/chat",
      home: "/home/agent",
      pid: 12345,
      uid: 2001,
      gid: 2001
    };
  }

  async send(_sessionKey: string, line: string): Promise<void> {
    this.sent.push(line);
    const msg = JSON.parse(line) as { id?: number; method?: string };
    if (msg.method === "initialize") {
      this.emit({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true }
          }
        }
      });
    } else if (msg.method === "session/new") {
      this.emit({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "agent-sess-1",
          ...(this.modelValues === null
            ? {}
            : {
                configOptions: [
                  {
                    type: "select",
                    id: "model",
                    name: "Model",
                    category: "model",
                    currentValue: this.modelValues[0] ?? "m-default",
                    options: (this.modelValues ?? []).map((value) => ({
                      name: value,
                      value
                    }))
                  }
                ]
              })
        }
      });
    } else if (msg.method === "session/set_config_option") {
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    }
  }

  async read(
    _sessionKey: string,
    afterSeq: number
  ): Promise<{
    lines: readonly string[];
    firstSeq: number;
    nextSeq: number;
    exited: boolean;
    truncated: boolean;
  }> {
    const lines = this.outbox.slice(afterSeq);
    return { lines, firstSeq: afterSeq + 1, nextSeq: this.seq, exited: false, truncated: false };
  }

  async kill(): Promise<void> {}
  async execStart(): Promise<{ execId: number }> {
    return { execId: 1 };
  }
  async execPoll(): Promise<{
    output: string;
    done: boolean;
    exitCode: number | null;
    truncated: boolean;
    timedOut: boolean;
  }> {
    return { output: "", done: true, exitCode: 0, truncated: false, timedOut: false };
  }
  async execKill(): Promise<void> {}

  private emit(message: unknown): void {
    this.outbox.push(JSON.stringify(message));
    this.seq += 1;
  }
}

describe("setModel", () => {
  it("binds chat's default to the advertised current model before prompting", async () => {
    const agent = new ModelAgent(["m-1", "m-2"]);
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "chat:user:conv",
      "conv",
      "anthropic",
      "user-1",
      "chat"
    );

    await expect(client.setModelForChat(handle, "default")).resolves.toMatchObject({
      applied: true,
      mismatch: false
    });
    const switchSent = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "session/set_config_option");
    expect(switchSent.params.value).toBe("m-1");
    await client.close(handle);
  });

  it("sends the option when the agent advertises a model choice", async () => {
    const agent = new ModelAgent(["m-1", "m-2"]);
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "chat:user:conv",
      "conv",
      "anthropic",
      "user-1",
      "chat"
    );
    const result = await client.setModel(handle, "m-2");
    expect(result.applied).toBe(true);
    expect(result.mismatch).toBe(false);
    const switchSent = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "session/set_config_option");
    expect(switchSent.params).toMatchObject({
      sessionId: "agent-sess-1",
      configId: "model",
      value: "m-2"
    });
    await client.close(handle);
  });

  it("records a mismatch instead of sending an id the agent does not accept", async () => {
    const agent = new ModelAgent(["m-1", "m-2"]);
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "chat:user:conv",
      "conv",
      "anthropic",
      "user-1",
      "chat"
    );
    const result = await client.setModel(handle, "m-nope");
    expect(result.applied).toBe(false);
    expect(result.mismatch).toBe(true);
    const switchSent = agent.sent
      .map((line) => JSON.parse(line))
      .filter((msg) => msg.method === "session/set_config_option");
    expect(switchSent).toHaveLength(0);
    await client.close(handle);
  });

  it("falls back per row when no model option is advertised", async () => {
    const agent = new ModelAgent(null);
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "chat:user:conv",
      "conv",
      "anthropic",
      "user-1",
      "chat"
    );
    const result = await client.setModel(handle, "m-1");
    expect(result.applied).toBe(false);
    expect(result.mismatch).toBe(false);
    expect(result.mechanism).toContain("configOptions model");
    expect(result.note).toContain("login's default");
    await client.close(handle);
  });
});

describe("model option helpers", () => {
  it("finds the category model option only, nothing by name", () => {
    const categorized = {
      type: "select",
      id: "anything",
      name: "Anything",
      category: "model",
      currentValue: "a",
      options: []
    };
    expect(findModelOption([categorized] as never)).toBe(categorized);
    const named = {
      type: "select",
      id: "modelChoice",
      name: "Model choice",
      currentValue: "a",
      options: []
    };
    expect(findModelOption([named] as never)).toBeNull();
    expect(findModelOption([])).toBeNull();
  });

  it("reads accepted ids from the option list, null when free-form", () => {
    const listed = {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "a",
      options: [
        { name: "A", value: "a" },
        { name: "B", value: "b" }
      ]
    };
    expect(acceptedOptionValues(listed as never)).toEqual(new Set(["a", "b"]));
    const freeform = { type: "select", id: "model", name: "Model", currentValue: "a" };
    expect(acceptedOptionValues(freeform as never)).toBeNull();
  });
});
