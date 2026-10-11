import type { DataContextDb } from "@moss/db";
import type { MossModuleManifest, ToolExecute } from "@moss/module-sdk";

export function fakeManifests(events: () => unknown[]): MossModuleManifest[] {
  const tools: Record<string, unknown> = {
    "commitments.listVisible": { commitments: [] },
    "tasks.list": { items: [] },
    "calendar.listVisibleEvents": () => ({
      events: events(),
      accounts: [],
      gaps: []
    }),
    "email.listVisibleMessages": { messages: [], accounts: [], gaps: [] },
    "chat.listTodaysTurns": { turns: [] }
  };
  const assistantTools = Object.keys(tools).map((name) => {
    const execute: ToolExecute = async () => {
      const data = tools[name];
      const resolved = typeof data === "function" ? (data as () => unknown)() : data;
      return { data: resolved as Record<string, unknown> };
    };
    return {
      name,
      description: name,
      permissionId: "x.view",
      risk: "read" as const,
      inputSchema: { type: "object", properties: {} },
      execute
    };
  });
  return [
    {
      id: "fake-auto",
      name: "FakeAuto",
      version: "0.0.0",
      publisher: "test",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools,
      sourceBehaviors: []
    }
  ];
}

export function prefsFake(values: Record<string, unknown>) {
  return {
    async get(_scopedDb: DataContextDb, key: string) {
      return values[key] ?? null;
    },
    async getWithMetadata<T>(_scopedDb: DataContextDb, key: string) {
      const value = (values[key] ?? null) as T | null;
      return value === null ? null : { value, updatedAt: new Date() };
    },
    async upsert(_scopedDb: DataContextDb, key: string, value: unknown) {
      values[key] = value;
    }
  };
}
