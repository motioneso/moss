import { describe, expect, it } from "vitest";

import { collectNewsExportSection } from "../../packages/news/src/data-lifecycle.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";

describe("news manifest — addTopic guidance removal (#1265)", () => {
  it("does not accept a guidance field on the assistant-tool schema", () => {
    const tools = newsModuleManifest.assistantTools ?? [];
    const addTopic = tools.find((candidate) => candidate.name === "news.addTopic");
    expect(addTopic, "expected tool news.addTopic to exist").toBeDefined();
    const schema = addTopic?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("guidance");
    expect(schema.properties).toHaveProperty("label");
  });

  it("keeps addTopic granted_at_install with only label required", () => {
    const tools = newsModuleManifest.assistantTools ?? [];
    const addTopic = tools.find((candidate) => candidate.name === "news.addTopic");
    const schema = addTopic?.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["label"]);
    expect(addTopic?.selfOperationGrant).toBe("granted_at_install");
  });

  it("declares its export collector", () => {
    expect(newsModuleManifest.dataLifecycle?.exportSections).toEqual([
      {
        key: "newsPersonalization",
        displayName: "News personalization",
        collect: collectNewsExportSection
      }
    ]);
  });
});
