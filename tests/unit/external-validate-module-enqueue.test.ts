import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";
import type { ModuleParamScalarSchema, ModuleParamsSchema } from "@moss/module-sdk";

const base = {
  schemaVersion: 1,
  id: "acme-widgets",
  name: "Acme Widgets",
  version: "0.1.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" },
  runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 }
};

function validateQueue(options: Readonly<Record<string, unknown>>) {
  return validateExternalModuleManifest(
    {
      ...base,
      worker: { queues: [{ name: "acme-widgets.generate", handler: "generate", ...options }] }
    },
    base.id,
    "0.1.0"
  );
}

function expectRejected(options: Readonly<Record<string, unknown>>, message: string) {
  const result = validateQueue(options);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.join(" ")).toContain(message);
}

const metadataScalars: readonly ModuleParamScalarSchema[] = [
  { type: "uuid" },
  { type: "identifier" },
  { type: "timestamp" },
  { type: "boolean" },
  { type: "null" },
  { type: "integer", min: 0, max: 6 },
  { type: "number", min: 0, max: 1 },
  { type: "enum", values: ["pending", "complete"] }
];

describe("module job enqueue manifest opt-in (#3715)", () => {
  it.each(["true", 1, 0, null, {}, []])("rejects non-boolean flag %j", (flag) => {
    expectRejected(
      { allowModuleEnqueue: flag, paramsSchema: { type: "object", fields: {} } },
      "allowModuleEnqueue must be a boolean"
    );
  });

  it("requires a schema for an opted-in queue", () => {
    expectRejected(
      { allowModuleEnqueue: true },
      "allowModuleEnqueue requires a valid paramsSchema"
    );
  });

  it.each([null, {}, { type: "unknown" }, { type: "array", items: { type: "uuid" } }])(
    "rejects invalid opted-in schema %j",
    (paramsSchema) => {
      expectRejected(
        { allowModuleEnqueue: true, paramsSchema },
        "allowModuleEnqueue requires a valid paramsSchema"
      );
    }
  );

  const text: ModuleParamScalarSchema = { type: "string", maxLength: 128 };
  const freeTextSchemas: readonly ModuleParamsSchema[] = [
    text,
    { type: "array", items: text, maxItems: 2 },
    { type: "object", fields: { content: text } },
    {
      type: "object",
      fields: { planId: { type: "uuid" }, content: { type: "array", items: text, maxItems: 2 } }
    }
  ];

  it.each(freeTextSchemas)("rejects free text anywhere in opted-in schema %j", (paramsSchema) => {
    expectRejected(
      { allowModuleEnqueue: true, paramsSchema },
      "allowModuleEnqueue paramsSchema must not contain string fields"
    );
  });

  for (const scalar of metadataScalars) {
    const schemas: readonly ModuleParamsSchema[] = [
      scalar,
      { type: "array", items: scalar, maxItems: 7 },
      { type: "object", fields: { value: scalar } },
      { type: "object", fields: { values: { type: "array", items: scalar, maxItems: 7 } } }
    ];
    it.each(schemas)(`preserves opted-in ${scalar.type} schema %j`, (paramsSchema) => {
      const result = validateQueue({ allowModuleEnqueue: true, paramsSchema });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.worker?.queues?.[0]).toMatchObject({
          name: "acme-widgets.generate",
          handler: "generate",
          allowModuleEnqueue: true,
          paramsSchema
        });
      }
    });
  }

  it("accepts an explicitly empty metadata object schema", () => {
    expect(
      validateQueue({ allowModuleEnqueue: true, paramsSchema: { type: "object", fields: {} } }).ok
    ).toBe(true);
  });

  it.each([{}, { allowModuleEnqueue: false }])(
    "preserves legacy queues with options %j",
    (flag) => {
      expect(validateQueue(flag).ok).toBe(true);
      for (const paramsSchema of freeTextSchemas) {
        const result = validateQueue({ ...flag, paramsSchema });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.manifest.worker?.queues?.[0]?.paramsSchema).toEqual(paramsSchema);
          expect(result.manifest.worker?.queues?.[0]?.allowModuleEnqueue).toBe(
            flag.allowModuleEnqueue
          );
        }
      }
    }
  );
});
