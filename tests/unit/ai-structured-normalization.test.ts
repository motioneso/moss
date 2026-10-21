import { expect, it } from "vitest";
import type { DataContextDb } from "@moss/db";
import {
  generateStructured,
  type GenerateStructuredDeps,
  type AiProviderWithSealedCredential
} from "@moss/ai";

async function generate(property: Record<string, unknown>, value: unknown, required = true) {
  const deps: GenerateStructuredDeps = {
    repository: {
      resolveModelForService: async () => {
        throw new Error("Explicit model must not be rerouted");
      },
      selectProviderWithCredential: async () =>
        ({
          id: "provider",
          auth_method: "api_key",
          encrypted_credential: "synthetic"
        }) as unknown as AiProviderWithSealedCredential
    },
    cipher: { decryptJson: () => ({ apiKey: "synthetic" }) },
    createAdapter: () => ({
      generateStructured: async () => ({
        rawObject: value === undefined ? {} : { value },
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    })
  };
  return generateStructured(
    {} as DataContextDb,
    {
      service: "module.chat",
      explicitModel: {
        id: "model",
        provider_config_id: "provider",
        provider_kind: "openai-compatible",
        provider_model_id: "synthetic"
      },
      schema: {
        type: "object",
        properties: { value: property },
        required: required ? ["value"] : [],
        additionalProperties: false
      },
      prompt: "Synthetic fixture",
      singleAttempt: true
    },
    deps
  );
}

const interval = {
  type: "object",
  required: ["kind", "seconds"],
  additionalProperties: false,
  properties: {
    kind: { const: "interval" },
    seconds: { type: "integer", minimum: 60, maximum: 86399 }
  }
};

it.each([
  [
    { anyOf: [{ type: "null" }, interval] },
    '{"kind":"interval","seconds":"300"}',
    { kind: "interval", seconds: 300 }
  ],
  [
    {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { enum: ["daily", "weekly"] } }
        }
      ]
    },
    '{"kind":"daily"}',
    { kind: "daily" }
  ],
  [{ type: ["integer", "null"] }, "null", null],
  [{ type: ["integer", "null"] }, undefined, null],
  [{ type: "integer", minimum: 60 }, "300", 300],
  [{ $id: "urn:test:edit-shape-integer", type: "integer" }, "300", 300],
  [{ type: ["integer", "null"] }, "0", 0]
])("repairs only schema-valid interpretations: %j", async (schema, value, expected) => {
  expect(await generate(schema as Record<string, unknown>, value)).toMatchObject({
    ok: true,
    object: { value: expected }
  });
});

it.each([
  [{ type: "integer", minimum: 60 }, "59"],
  [{ type: "integer", maximum: 300 }, "301"],
  [{ type: "integer" }, "1.5"],
  [{ type: "integer" }, "1e2"],
  [{ type: "integer" }, " 60"],
  [{ type: "integer" }, "060"],
  [{ type: "integer" }, "9007199254740993"],
  [{ type: "integer" }, undefined],
  [{ type: "boolean" }, "false"],
  [{ type: "null" }, "NULL"],
  [{ anyOf: [{ type: "null" }, interval] }, '{"kind":"interval","seconds":"59"}'],
  [{ anyOf: [{ type: "null" }, interval] }, '{"kind":"interval","seconds":"300","extra":true}'],
  [{ anyOf: [{ type: "null" }, interval] }, "{broken}"],
  [{ allOf: [{ type: "integer" }] }, "300"]
])("refuses invalid or unsupported conversions: %j", async (schema, value) => {
  expect(await generate(schema as Record<string, unknown>, value)).toEqual({
    ok: false,
    error: "validation_failed"
  });
});

it.each(["null", "300", '{"kind":"daily"}'])(
  "preserves an already valid string %s",
  async (value) => {
    expect(
      await generate({ anyOf: [{ type: "string" }, { type: "null" }, interval] }, value)
    ).toMatchObject({ ok: true, object: { value } });
  }
);

it("does not fill an optional nullable field", async () => {
  expect(await generate({ type: ["integer", "null"] }, undefined, false)).toMatchObject({
    ok: true,
    object: {}
  });
});

it("refuses two distinct schema-valid repairs", async () => {
  const branch = (key: string) => ({
    type: "object",
    additionalProperties: false,
    required: [key],
    properties: { [key]: { type: "null" } }
  });
  expect(await generate({ anyOf: [branch("first"), branch("second")] }, "{}")).toEqual({
    ok: false,
    error: "validation_failed"
  });
});

it("still applies sibling constraints around anyOf", async () => {
  expect(
    await generate({ anyOf: [{ type: "integer" }, { type: "null" }], enum: [100] }, "300")
  ).toEqual({ ok: false, error: "validation_failed" });
});
