import { describe, expect, it, vi } from "vitest";

// Fail-first cover for the p8 briefing-writer stand-in wiring: the chunk
// creates exactly the rows synthesis needs and nothing else, and the
// opt-in threads from provision options down to the seed level.

const aiMocks = vi.hoisted(() => ({
  createProvider: vi.fn().mockResolvedValue({ id: "provider-1" }),
  createModel: vi.fn().mockResolvedValue({ id: "model-1" }),
  setServiceBinding: vi.fn().mockResolvedValue(undefined),
  encryptJson: vi.fn((value: unknown) => ({ encrypted: value }))
}));

vi.mock("@moss/ai", () => ({
  AiRepository: class {
    createProvider = aiMocks.createProvider;
    createModel = aiMocks.createModel;
    setServiceBinding = aiMocks.setServiceBinding;
  },
  createAiSecretCipher: () => ({ encryptJson: aiMocks.encryptJson })
}));

import { seedBriefingWriterAiProviderChunk } from "../uat/seed/chunks/briefing-writer-ai.js";

function fakeRunner() {
  return {
    withDataContext: async (_options: unknown, fn: (scopedDb: unknown) => Promise<void>) => fn({})
  };
}

describe("seedBriefingWriterAiProviderChunk", () => {
  it("seeds an economy summarization model on a real-base-URL provider", async () => {
    await seedBriefingWriterAiProviderChunk(
      fakeRunner() as never,
      "admin-1",
      "http://uat-1-bwfixture:8081"
    );

    expect(aiMocks.createProvider).toHaveBeenCalledOnce();
    const providerInput = aiMocks.createProvider.mock.calls[0]![1] as Record<string, unknown>;
    expect(providerInput.providerKind).toBe("openai-compatible");
    expect(providerInput.baseUrl).toBe("http://uat-1-bwfixture:8081");

    expect(aiMocks.createModel).toHaveBeenCalledOnce();
    const modelInput = aiMocks.createModel.mock.calls[0]![1] as Record<string, unknown>;
    expect(modelInput.capabilities).toEqual(["summarization"]);
    expect(modelInput.tier).toBe("economy");
  });

  it("writes no binding and touches no other rows, so news resolution cannot move", async () => {
    await seedBriefingWriterAiProviderChunk(
      fakeRunner() as never,
      "admin-1",
      "http://uat-1-bwfixture:8081"
    );

    // Synthesis resolves the writer through automatic capability routing,
    // not a service binding — and a binding write here is exactly how a
    // second fixture could steal another module's model.
    expect(aiMocks.setServiceBinding).not.toHaveBeenCalled();
  });

  it("stores a fake credential, never a real secret", async () => {
    await seedBriefingWriterAiProviderChunk(
      fakeRunner() as never,
      "admin-1",
      "http://uat-1-bwfixture:8081"
    );

    const encrypted = aiMocks.createProvider.mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(encrypted)).not.toMatch(/sk-ant-|sk-|AIza|ghp_/);
  });
});
