import { describe, expect, it } from "vitest";

import { scratchpadModuleManifest } from "../manifest.js";

// #2236 slice 1: the manifest is the declarative contract that boot-time checks read (route
// coverage, module registry consistency, data lifecycle deletion). These tests pin down the
// shape so a later change can't silently drop a route, a tool, or the lifecycle declaration.

describe("scratchpadModuleManifest", () => {
  it("declares all four scratchpad routes", () => {
    const routes = scratchpadModuleManifest.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toEqual([
      "GET /api/scratchpad",
      "PUT /api/scratchpad",
      "POST /api/scratchpad/append",
      "PATCH /api/scratchpad/settings"
    ]);
  });

  it("owns exactly the app.scratchpads table", () => {
    expect(scratchpadModuleManifest.database.ownedTables).toEqual(["app.scratchpads"]);
  });

  it("declares scratchpad.read as a read-risk tool", () => {
    const readTool = scratchpadModuleManifest.assistantTools.find(
      (tool) => tool.name === "scratchpad.read"
    );
    expect(readTool).toBeDefined();
    expect(readTool?.risk).toBe("read");
  });

  it("declares scratchpad.append as a write-risk tool that auto-runs once installed", () => {
    const appendTool = scratchpadModuleManifest.assistantTools.find(
      (tool) => tool.name === "scratchpad.append"
    );
    expect(appendTool).toBeDefined();
    expect(appendTool?.risk).toBe("write");
    expect(appendTool?.executionPolicy).toBe("auto");
    expect(appendTool?.selfOperationGrant).toBe("granted_at_install");
  });

  it("keeps the owning action family at ask_each_time by default", () => {
    const family = scratchpadModuleManifest.assistantActionFamilies?.find(
      (item) => item.id === "scratchpad_changes"
    );
    expect(family).toBeDefined();
    expect(family?.defaultTier).toBe("ask_each_time");
  });

  it("overrides the deletion count predicate to match the user_id column", () => {
    const table = scratchpadModuleManifest.dataLifecycle?.deletion.tables.find(
      (item) => item.table === "app.scratchpads"
    );
    expect(table).toBeDefined();
    expect(table?.countPredicate).toBe("user_id = $1::uuid");
  });

  it("is a required, default-enabled module", () => {
    expect(scratchpadModuleManifest.lifecycle).toBe("required");
    expect(scratchpadModuleManifest.availability.defaultEnabled).toBe(true);
    expect(scratchpadModuleManifest.availability.required).toBe(true);
  });
});
