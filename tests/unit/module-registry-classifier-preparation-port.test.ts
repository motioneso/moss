import { describe, expect, it, vi } from "vitest";

import type * as AiModule from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import { createClassifierPreparationPort } from "../../packages/module-registry/src/classifier-preparation-port.js";

/**
 * #2984 R2.2: the sorting pass sends the provider a strict answer shape but checks the reply
 * against a looser one, so one malformed item costs one tool. The production port must pass both.
 */

const sent = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[] }));

vi.mock("@moss/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    AiRepository: vi.fn(),
    createAiSecretCipher: vi.fn(() => ({})),
    generateStructured: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      sent.inputs.push(input);
      return { ok: true, object: { tools: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    })
  };
});

const model = {
  id: "m1",
  providerConfigId: "p1",
  providerKind: "opaque-kind",
  providerModelId: "opaque-model"
};

describe("classifier preparation port", () => {
  it("sends the strict schema to the provider and checks the reply with the looser one", async () => {
    const schema = { type: "object", required: ["tools"], additionalProperties: false };
    const replySchema = { type: "object", required: ["tools"] };
    const port = createClassifierPreparationPort({});

    await port.runStructuredDraft({} as DataContextDb, {
      model,
      schema,
      replySchema,
      prompt: "p",
      maxOutputTokens: 10
    });
    await port.runStructuredDraft({} as DataContextDb, {
      model,
      schema,
      prompt: "p",
      maxOutputTokens: 10
    });

    expect(sent.inputs[0]).toMatchObject({ schema, replySchema });
    expect(sent.inputs[1]).toMatchObject({ schema });
    expect(sent.inputs[1]).not.toHaveProperty("replySchema");
  });
});
