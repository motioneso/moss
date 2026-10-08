import { describe, expect, it, vi } from "vitest";
import type { TmuxIo } from "@moss/ai";
import { StructuredTransportUnavailableError } from "@moss/ai";
import {
  ChatEngineRpcClient,
  type RpcConnection
} from "../../packages/chat/src/live/chat-engine-rpc-client.js";
import { createStructuredEngine } from "../../packages/chat/src/live/structured-engine-selection.js";
import { ConstrainedStructuredEngine } from "../../packages/chat/src/live/constrained-structured-engine.js";
import { ConstrainedClaudeUnsupportedError } from "../../packages/chat/src/live/constrained-claude-profile.js";
import { CliChatUnavailableError, mapRpcError } from "../../packages/chat/src/live/errors.js";
import { toErrFrame } from "../../packages/cli-runner/src/connection.js";
import { createConstrainedCliStructuredAdapterFactory } from "../../packages/chat/src/live/constrained-structured-adapter.js";
const launchOptions = {
  neutralDir: "/unused",
  personaPath: "/unused/persona",
  personaText: "fixed guidance",
  model: "chosen-model",
  schema: { type: "object" }
};

describe("constrained profile RPC boundary", () => {
  it("carries the explicit marker and owner through structured launch", async () => {
    const launch = vi.fn(async () => ({ offset: 0 }));
    const client = new ChatEngineRpcClient(
      "anthropic",
      "constrained-key",
      { launch } as unknown as RpcConnection,
      "non_interactive",
      undefined,
      true,
      "owner-id",
      true
    );
    await client.launchStructured(launchOptions);
    expect(launch).toHaveBeenCalledWith(
      "constrained-key",
      expect.objectContaining({
        constrainedStructured: true,
        needsStructuredOutput: true,
        userId: "owner-id",
        model: "chosen-model",
        schema: launchOptions.schema
      })
    );
    expect(JSON.stringify(launch.mock.calls)).not.toContain("/unused");
  });
  it("does not infer the constrained profile from ordinary structured callers", async () => {
    const io = {} as TmuxIo;
    expect(
      await createStructuredEngine("anthropic", "ordinary", io, {
        executionMode: "non_interactive",
        needsStructuredOutput: true
      })
    ).not.toBeInstanceOf(ConstrainedStructuredEngine);
    expect(
      await createStructuredEngine("anthropic", "constrained", io, {
        executionMode: "non_interactive",
        needsStructuredOutput: true,
        constrainedStructured: true
      })
    ).toBeInstanceOf(ConstrainedStructuredEngine);
  });
  it("retains only the fixed unsupported discriminator through runner error framing and adapter", async () => {
    const original = new ConstrainedClaudeUnsupportedError();
    expect(original).toBeInstanceOf(CliChatUnavailableError);
    const frame = toErrFrame(1, "boot", original);
    expect(frame.error.code).toBe("unavailable");
    const error = mapRpcError(frame.error.code, frame.error.message);
    const kill = vi.fn(async () => {});
    const factory = vi.fn(async () => ({
      provider: "anthropic" as const,
      launch: vi.fn(),
      submit: vi.fn(),
      interrupt: kill,
      kill,
      isAlive: async () => false,
      readNew: vi.fn(),
      launchStructured: async () => {
        throw error;
      },
      submitStructured: vi.fn(),
      readStructured: vi.fn()
    }));
    await expect(
      createConstrainedCliStructuredAdapterFactory(factory)("anthropic").generateStructured({
        actorUserId: "owner",
        model: { provider_kind: "anthropic", provider_model_id: "chosen" },
        schema: { type: "object" },
        messages: [{ role: "user", content: "private synthetic transcript" }],
        maxOutputTokens: 8192
      })
    ).rejects.toBeInstanceOf(StructuredTransportUnavailableError);
    expect(kill).toHaveBeenCalled();
  });
});
