import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { MossModuleManifest, ToolContext, ToolInput, ToolResult } from "@moss/module-sdk";

/** Records every execute call so tests can assert a handler did/did not run. */
export const exampleToolCalls: { name: string; input: ToolInput; actorUserId: string }[] = [];

async function record(
  name: string,
  scopedDb: DataContextDb,
  input: ToolInput,
  ctx: ToolContext
): Promise<ToolResult> {
  assertDataContextDb(scopedDb); // proves the gateway scoped us under withDataContext
  exampleToolCalls.push({ name, input, actorUserId: ctx.actorUserId });
  return { data: { ok: true, name, echo: input.value ?? null, actor: ctx.actorUserId } };
}

export const exampleToolModule: MossModuleManifest = {
  id: "example",
  name: "Example",
  version: "0.0.0",
  publisher: "test",
  lifecycle: "optional",
  compatibility: { jarv1s: "*" },
  assistantActionFamilies: [
    {
      id: "dummy",
      label: "Dummy family",
      description: "Dummy family for tests",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto"]
    }
  ],
  assistantTools: [
    {
      name: "example.read",
      description: "Read fixture.",
      permissionId: "example.view",
      risk: "read",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      execute: (db, input, ctx) => record("example.read", db as DataContextDb, input, ctx)
    },
    {
      name: "example.write",
      description: "Write fixture.",
      permissionId: "example.update",
      risk: "write",
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      execute: (db, input, ctx) => record("example.write", db as DataContextDb, input, ctx),
      summarize: (input) => `Write the value "${String(input.value)}"`
    },
    {
      name: "example.slowWrite",
      description: "Write fixture with a real delay before recording the call.",
      permissionId: "example.update",
      risk: "write",
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      execute: async (db, input, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return record("example.slowWrite", db as DataContextDb, input, ctx);
      },
      summarize: (input) => `Slow write the value "${String(input.value)}"`
    },
    {
      name: "example.autoWrite",
      description: "Auto write fixture.",
      permissionId: "example.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "dummy",
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      execute: (db, input, ctx) => record("example.autoWrite", db as DataContextDb, input, ctx)
    },
    {
      name: "example.destroy",
      description: "Destroy fixture.",
      permissionId: "example.delete",
      risk: "destructive",
      actionFamilyId: "dummy",
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      execute: (db, input, ctx) => record("example.destroy", db as DataContextDb, input, ctx)
    },
    {
      name: "example.boom",
      description: "Always throws (error-path fixture).",
      permissionId: "example.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("SECRET internal detail postgres://user:pw@host/db");
      }
    },
    {
      name: "example.declaration-only",
      description: "Declared without a handler (legacy-style).",
      permissionId: "example.view",
      risk: "read"
    },
    {
      name: "example.list",
      description: "Returns a uniform flat list (tabular output fixture).",
      permissionId: "example.view",
      risk: "read" as const,
      inputSchema: { type: "object", properties: {} },
      execute: async (db, _input, ctx: ToolContext) => {
        assertDataContextDb(db as DataContextDb);
        exampleToolCalls.push({ name: "example.list", input: {}, actorUserId: ctx.actorUserId });
        return {
          data: {
            items: [
              { id: "a1", name: "Alpha", status: "active" },
              { id: "a2", name: "Beta", status: "inactive" }
            ]
          }
        };
      }
    }
  ]
};
