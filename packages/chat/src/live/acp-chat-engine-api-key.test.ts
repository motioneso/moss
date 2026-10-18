import { describe, expect, it, vi } from "vitest";

import { AcpChatEngine, RpcAcpTunnel, toAcpProviderKind } from "./acp-chat-engine.js";
import { API_KEY_REJECTED_MESSAGE } from "./auth-errors.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import { CliChatUnavailableError } from "./errors.js";
import { PromptErrorTunnel } from "../../../../tests/unit/helpers/acp-prompt-error-tunnel.js";

describe("API-key chat", () => {
  const launchOpts = { neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" };

  it("routes API-key rows by provider kind alone", () => {
    expect(toAcpProviderKind("anthropic", undefined, "api_key")).toBe("anthropic");
    expect(toAcpProviderKind("openai-compatible", undefined, "api_key")).toBe("opencode");
    expect(toAcpProviderKind("openai-compatible", "codex-acp", "api_key")).toBe("opencode");
    expect(toAcpProviderKind("openai-compatible", undefined, "cli")).toBe("openai");
    expect(() => toAcpProviderKind("google", undefined, "api_key")).toThrow(
      CliChatUnavailableError
    );
  });

  it("names the key, not a CLI sign-in, when the provider refuses a prompt", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-prompt", {
      tunnel: new PromptErrorTunnel(),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-prompt",
      reportLoginRejected: loginRejected
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CliChatUnavailableError",
      message: API_KEY_REJECTED_MESSAGE
    });
    expect(failure).not.toHaveProperty("cause");
    expect(loginRejected).not.toHaveBeenCalled();
    await engine.kill();
  });

  it("names the key when an OpenCode API-key launch is refused", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:api-key-launch", {
      tunnel: new PromptErrorTunnel(true),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-launch",
      reportLoginRejected: loginRejected
    });
    const failure = await engine.launch(launchOpts).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CliChatUnavailableError",
      message: API_KEY_REJECTED_MESSAGE
    });
    expect(failure).not.toHaveProperty("cause");
    expect(loginRejected).not.toHaveBeenCalled();
  });

  it("treats a provider 401 during an API-key prompt as a rejected key", async () => {
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:api-key-401", {
      tunnel: new PromptErrorTunnel(false, {
        code: -32603,
        message: "Upstream 401: invalid api key"
      }),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-401"
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(engine.readNew(0)).rejects.toMatchObject({ message: API_KEY_REJECTED_MESSAGE });
    await engine.kill();
  });

  // Phase 0 (2026-10-17): with a wrong key, both agents answer the first prompt with a JSON-RPC
  // internal error (-32603) that wraps the provider's 401, never "Authentication required".
  it.each([
    [
      "claude agent",
      "anthropic" as const,
      {
        code: -32603,
        message: "Internal error: Failed to authenticate. API Error: 401",
        data: { errorKind: "authentication_failed" }
      }
    ],
    [
      "OpenCode",
      "openai-compatible" as const,
      {
        code: -32603,
        message: "Internal error: Unauthorized: Invalid API key",
        data: { name: "APIError" }
      }
    ]
  ])(
    "classifies the %s internal error wrapping a 401 as a rejected key",
    async (_label, provider, wrongKeyError) => {
      const loginRejected = vi.fn();
      const engine = new AcpChatEngine(provider, "chat:u1:api-key-internal", {
        tunnel: new PromptErrorTunnel(false, wrongKeyError),
        authMethod: "api_key",
        userId: "u1",
        projectId: "api-key-internal",
        reportLoginRejected: loginRejected
      });
      await engine.launch(launchOpts);
      await engine.submit("hello");
      await new Promise((resolve) => setTimeout(resolve, 25));
      const failure = await engine.readNew(0).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "CliChatUnavailableError",
        message: API_KEY_REJECTED_MESSAGE
      });
      expect(failure).not.toHaveProperty("cause");
      expect(JSON.stringify(failure)).not.toContain("Internal error");
      expect(String((failure as Error).message)).not.toContain("Internal error");
      expect(loginRejected).not.toHaveBeenCalled();
      await engine.kill();
    }
  );

  it.each([
    ["an authentication_failed kind", { errorKind: "authentication_failed" }],
    ["a 401 status", { status: 401 }],
    ["a nested 401 status code", { error: { statusCode: 401 } }]
  ])(
    "classifies a generic internal error whose data carries %s as a rejected key",
    async (_label, data) => {
      const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-data", {
        tunnel: new PromptErrorTunnel(false, { code: -32603, message: "Internal error", data }),
        authMethod: "api_key",
        userId: "u1",
        projectId: "api-key-data",
        reportLoginRejected: vi.fn()
      });
      await engine.launch(launchOpts);
      await engine.submit("hello");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(engine.readNew(0)).rejects.toMatchObject({ message: API_KEY_REJECTED_MESSAGE });
      await engine.kill();
    }
  );

  it.each([
    ["a 500 status", { status: 500, errorKind: "overloaded" }],
    ["a 401 buried in an unrelated field", { requestId: "req-401", detail: "status 401 earlier" }],
    ["a 401 number in a non-status field", { retryAfter: 401 }]
  ])("leaves a generic internal error whose data carries %s alone", async (_label, data) => {
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-other", {
      tunnel: new PromptErrorTunnel(false, { code: -32603, message: "Internal error", data }),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-other",
      reportLoginRejected: vi.fn()
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);
    expect((failure as Error).message).not.toBe(API_KEY_REJECTED_MESSAGE);
    await engine.kill();
  });

  it("leaves the same internal 401 alone on a CLI-login row", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("anthropic", "chat:u1:cli-internal", {
      tunnel: new PromptErrorTunnel(false, {
        code: -32603,
        message: "Internal error: Failed to authenticate. API Error: 401"
      }),
      userId: "u1",
      projectId: "cli-internal",
      reportLoginRejected: loginRejected
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);
    expect((failure as Error).message).not.toBe(API_KEY_REJECTED_MESSAGE);
    expect(loginRejected).not.toHaveBeenCalled();
    await engine.kill();
  });

  it("sends the credential with the spawn request, and only when one is given", async () => {
    const acpSpawn = vi.fn(async () => ({
      cwd: "/tmp/acp",
      home: "/tmp/home",
      pid: 1,
      uid: 1,
      gid: 1
    }));
    const connection = { acpSpawn } as unknown as RpcConnection;
    const credential = { baseUrl: null, apiKey: "test-key-never-echo-0002", model: "org/model" };
    await new RpcAcpTunnel(connection, "chat:u1:a", { credential }).spawn(
      "chat:u1:a",
      "a",
      "anthropic",
      "u1",
      "chat"
    );
    await new RpcAcpTunnel(connection, "chat:u1:b").spawn(
      "chat:u1:b",
      "b",
      "anthropic",
      "u1",
      "chat"
    );
    const calls = acpSpawn.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(calls[0]?.[1]).toEqual({
      projectId: "a",
      providerKind: "anthropic",
      userId: "u1",
      profile: "chat",
      credential
    });
    expect(calls[1]?.[1]).not.toHaveProperty("credential");
  });

  // No "sk-" prefix, so the generic secret patterns cannot hide a missing exact mask.
  const LAUNCH_KEY = "localproxy0005neverlog";

  it.each([
    ["at the start", `${LAUNCH_KEY} rejected by upstream`],
    ["in the middle", `upstream said ${LAUNCH_KEY} is over quota`],
    ["at the end", `quota exceeded for ${LAUNCH_KEY}`],
    ["repeated", `${LAUNCH_KEY}/${LAUNCH_KEY} twice`]
  ])("masks the key %s of a non-auth API-key launch error", async (_label, message) => {
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-mask", {
      tunnel: new PromptErrorTunnel(true, undefined, {
        code: -32603,
        message,
        data: { echo: LAUNCH_KEY }
      }),
      authMethod: "api_key",
      apiKey: LAUNCH_KEY,
      userId: "u1",
      projectId: "api-key-mask"
    });
    const failure = await engine.launch(launchOpts).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[redacted]");
    expect((failure as Error).message).not.toContain(LAUNCH_KEY);
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(LAUNCH_KEY);
  });
});
