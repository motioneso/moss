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

// #2008: a publisher key is only ever typed into the News settings form by the person who owns
// it. No assistant tool may hold the permission that guards the credential routes, or the model
// would be able to connect, replace or revoke a key on somebody's behalf.
describe("news assistant tools and publisher keys (#2008)", () => {
  it("gives no assistant tool the news.credentials permission", () => {
    const tools = newsModuleManifest.assistantTools ?? [];
    const holders = tools
      .filter((tool) => tool.permissionId === "news.credentials")
      .map((tool) => tool.name);
    expect(holders).toEqual([]);
  });

  it("declares credentialed source status as an empty-input read-only tool", () => {
    const tool = (newsModuleManifest.assistantTools ?? []).find(
      (candidate) => candidate.name === "news.credentialedSourceStatus"
    );
    expect(tool).toBeDefined();
    expect(tool?.permissionId).toBe("news.view");
    expect(tool?.risk).toBe("read");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

// #2282: the settings screen and the add-source feature now cover subreddits as well as
// publications, so their app-map copy must say so and the new migration must be declared.
describe("news manifest wording and migrations (#2282)", () => {
  it("describes the News settings screen as covering publications and subreddits", () => {
    const setting = newsModuleManifest.settings.find((candidate) => candidate.id === "news.prefs");
    expect(setting?.description).toBe(
      "Choose news topics, manage built-in, connected, and excluded publishers, and the " +
        "sources you add: a publication or a subreddit. Adding a source needs an AI model; " +
        "discovering topics across the web also needs web search."
    );
    expect(setting?.description).not.toContain("custom, and excluded publishers");
  });

  it("describes the add-source feature as accepting an r/name subreddit input", () => {
    const feature = newsModuleManifest.features?.find(
      (candidate) => candidate.id === "news.add_source"
    );
    expect(feature?.description).toContain("r/name");
    expect(feature?.description).toContain("articles linked from");
  });

  it("declares the subreddit-sources migration", () => {
    expect(newsModuleManifest.database.migrations).toContain("sql/0218_news_source_kinds.sql");
  });
});
