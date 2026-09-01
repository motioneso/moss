import { describe, expect, it } from "vitest";

import { convertOpenApiSpec, mapMcpTool } from "@moss/integrations";

describe("mapMcpTool hints", () => {
  it("maps MCP annotation hints onto the discovered tool, leaving unset ones absent", () => {
    const raw = [
      { name: "read_state", description: "read", annotations: { readOnlyHint: true } },
      { name: "set_temp", description: "set", annotations: { idempotentHint: true } },
      { name: "delete_all", description: "delete", annotations: { destructiveHint: true } },
      { name: "bare", description: "bare" }
    ];
    const tools = raw.map((t) => mapMcpTool(t as never));

    expect(tools.find((t) => t.name === "read_state")).toMatchObject({ readOnly: true });
    expect(tools.find((t) => t.name === "read_state")!.idempotent).toBeUndefined();
    expect(tools.find((t) => t.name === "set_temp")).toMatchObject({ idempotent: true });
    expect(tools.find((t) => t.name === "set_temp")!.readOnly).toBeUndefined();
    expect(tools.find((t) => t.name === "delete_all")).toMatchObject({ destructive: true });
    const bare = tools.find((t) => t.name === "bare")!;
    expect(bare.readOnly).toBeUndefined();
    expect(bare.idempotent).toBeUndefined();
    expect(bare.destructive).toBeUndefined();
  });
});

describe("convertOpenApiSpec hints", () => {
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/things": {
        get: { operationId: "listThings" },
        post: { operationId: "createThing" },
        put: { operationId: "replaceThing" },
        patch: { operationId: "patchThing" },
        delete: { operationId: "deleteThing" }
      }
    }
  };

  it("maps method to readOnly/idempotent hints, and leaves destructive unset", () => {
    const tools = convertOpenApiSpec(spec);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.listThings).toMatchObject({ readOnly: true, idempotent: true });
    expect(byName.replaceThing).toMatchObject({ idempotent: true });
    expect(byName.replaceThing.readOnly).toBeUndefined();
    expect(byName.deleteThing).toMatchObject({ idempotent: true });
    expect(byName.deleteThing.readOnly).toBeUndefined();
    expect(byName.createThing.readOnly).toBeUndefined();
    expect(byName.createThing.idempotent).toBeUndefined();
    expect(byName.patchThing.readOnly).toBeUndefined();
    expect(byName.patchThing.idempotent).toBeUndefined();

    for (const t of tools) expect(t.destructive).toBeUndefined();
  });
});

describe("stored discovery JSON predating the hint fields", () => {
  it("still loads tools with no readOnly/idempotent/destructive keys present", () => {
    const stored = JSON.parse(
      '[{"name":"legacy","description":"legacy","group":"","inputSchema":null}]'
    );
    expect(stored[0].readOnly).toBeUndefined();
    expect(stored[0].idempotent).toBeUndefined();
    expect(stored[0].destructive).toBeUndefined();
  });
});
