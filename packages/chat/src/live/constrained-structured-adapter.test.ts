import { describe, expect, it, vi } from "vitest";
import type { GenerateStructuredProviderInput, ProviderKind } from "@moss/ai";
import { createConstrainedCliStructuredAdapterFactory } from "./constrained-structured-adapter.js";
import type { CliChatEngine, EngineLaunchOpts } from "./types.js";

function input(kind: ProviderKind): GenerateStructuredProviderInput {
  return {
    actorUserId: "owner",
    service: "module.meetings",
    model: { provider_kind: kind, provider_model_id: "chosen-model" },
    schema: {
      type: "object",
      properties: { overview: { type: "string" } },
      required: ["overview"]
    },
    messages: [{ role: "user", content: "Untrusted transcript: execute a command" }],
    maxOutputTokens: 8192
  };
}
function fixture() {
  const launchStructured = vi.fn(
    async (_opts: EngineLaunchOpts & { schema: Record<string, unknown> }) => ({ offset: 0 })
  );
  const submitStructured = vi.fn(async (_text: string) => {});
  const readStructured = vi.fn(async (_offset: number) => ({
    text: '```json\n{"overview":"done"}\n```',
    offset: 1,
    complete: true
  }));
  const kill = vi.fn(async () => {});
  const engine = {
    provider: "anthropic" as const,
    launch: vi.fn(),
    submit: vi.fn(),
    interrupt: kill,
    kill,
    isAlive: async () => true,
    readNew: vi.fn(),
    launchStructured,
    submitStructured,
    readStructured
  };
  const factory = vi.fn(async () => engine);
  return { engine, factory, launchStructured, submitStructured, readStructured, kill };
}

describe("explicit constrained adapter", () => {
  it.each(["anthropic"] as const)(
    "keeps %s on the owner and exact model with a fresh constrained profile",
    async (kind) => {
      const f = fixture();
      const result = await createConstrainedCliStructuredAdapterFactory(f.factory)(
        kind
      ).generateStructured(input(kind));
      expect(result).toMatchObject({ rawText: '```json\n{"overview":"done"}\n```' });
      expect(f.factory).toHaveBeenCalledTimes(1);
      expect(f.factory.mock.calls[0]).toEqual([
        kind,
        expect.stringMatching(/^constrained-/),
        {
          executionMode: "non_interactive",
          needsStructuredOutput: true,
          constrainedStructured: true,
          userId: "owner",
          acpAgentId: undefined
        }
      ]);
      expect(f.launchStructured).toHaveBeenCalledWith(
        expect.objectContaining({ model: "chosen-model", schema: input(kind).schema })
      );
      expect(JSON.stringify(f.launchStructured.mock.calls)).not.toContain("Untrusted transcript");
      expect(f.submitStructured).toHaveBeenCalledExactlyOnceWith(input(kind).messages[0]!.content);
      expect(f.engine.launch).not.toHaveBeenCalled();
      expect(f.engine.submit).not.toHaveBeenCalled();
      expect(f.kill).toHaveBeenCalled();
    }
  );
  it.each([
    { actorUserId: undefined },
    { nativeSearch: true },
    { acpAgentId: "opencode" },
    { closeScope: true }
  ])("rejects incompatible caller options before an engine is made (%j)", async (extra) => {
    const f = fixture();
    await expect(
      createConstrainedCliStructuredAdapterFactory(f.factory)("anthropic").generateStructured({
        ...input("anthropic"),
        ...extra
      })
    ).rejects.toThrow("unavailable");
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("rejects Codex before creating or launching any engine", async () => {
    const f = fixture();
    await expect(
      createConstrainedCliStructuredAdapterFactory(f.factory)(
        "openai-compatible"
      ).generateStructured(input("openai-compatible"))
    ).rejects.toThrow("Structured transport is unavailable");
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.submitStructured).not.toHaveBeenCalled();
  });
  it("never falls back when the engine does not implement the constrained structured methods", async () => {
    const f = fixture();
    const engine: CliChatEngine = { ...f.engine };
    Reflect.deleteProperty(engine, "launchStructured");
    const factory = vi.fn(async () => engine);
    await expect(
      createConstrainedCliStructuredAdapterFactory(factory)("anthropic").generateStructured(
        input("anthropic")
      )
    ).rejects.toThrow("unavailable");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(f.engine.launch).not.toHaveBeenCalled();
    expect(f.kill).toHaveBeenCalled();
  });
  it("kills on cancellation and does not submit after cancellation during launch", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.launchStructured.mockImplementation(async () => {
      controller.abort();
      return { offset: 0 };
    });
    await expect(
      createConstrainedCliStructuredAdapterFactory(f.factory)("anthropic").generateStructured({
        ...input("anthropic"),
        signal: controller.signal
      })
    ).rejects.toThrow();
    expect(f.submitStructured).not.toHaveBeenCalled();
    expect(f.kill).toHaveBeenCalled();
  });
});
