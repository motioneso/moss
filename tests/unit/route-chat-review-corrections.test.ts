import { describe, expect, it } from "vitest";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import { buildRouteCatalog } from "../../packages/module-registry/src/route-catalog.js";

const ID = "00000000-0000-4000-8000-000000000001";
const manifests = getBuiltInModuleManifests();
const catalog = buildRouteCatalog(manifests, []);

describe("slice 4 review corrections", () => {
  it.each([
    ["memory", "GET", "/api/memory/graph/recall"],
    ["memory", "GET", "/api/memory/graph/core"],
    ["memory", "GET", "/api/memory/dashboard"],
    ["memory", "POST", "/api/memory/graph/facts/:id/confirm"],
    ["memory", "POST", "/api/memory/graph/facts/:id/correct"],
    ["memory", "POST", "/api/memory/graph/facts/:id/status"],
    ["memory", "POST", "/api/memory/graph/facts/:id/mark-stale"],
    ["chat", "GET", "/api/chat/threads"],
    ["chat", "GET", "/api/chat/threads/:id/messages"],
    ["chat", "GET", "/api/chat/memory/facts"],
    ["chat", "GET", "/api/chat/memory/corrections"],
    ["chat", "GET", "/api/chat/messages/:messageId/provenance"]
  ])(
    "blocks unprojected %s aggregate %s %s independently of metadata",
    (moduleId, method, path) => {
      const manifest = manifests.find((module) => module.id === moduleId)!;
      const route = manifest.routes!.find(
        (route) => route.method === method && route.path === path
      )!;
      expect(route.chat).toMatchObject({ access: "blocked", blockedBecause: "data_scope_consent" });
      const wrong = { ...manifest, routes: [{ ...route, chat: { access: "read" as const } }] };
      expect(
        buildRouteCatalog([wrong], []).resolve(method, path.replace(/:[A-Za-z]+/g, ID))?.route
          .policy
      ).toMatchObject({ access: "blocked", blockedBecause: "data_scope_consent" });
    }
  );
  it("blocks task status changes that can train email triage, independently of metadata", () => {
    const taskManifest = manifests.find((module) => module.id === "tasks")!;
    const route = taskManifest.routes!.find(
      (route) => route.method === "PATCH" && route.path === "/api/tasks/:id"
    )!;
    expect(route.chat).toMatchObject({ access: "blocked", blockedBecause: "external_effect" });
    const wronglyLabelled = {
      ...taskManifest,
      routes: [{ ...route, chat: { access: "write" as const, title: "Update task" } }]
    };
    expect(
      buildRouteCatalog([wronglyLabelled], []).resolve("PATCH", `/api/tasks/${ID}`)?.route.policy
    ).toMatchObject({ access: "blocked", blockedBecause: "external_effect" });
  });

  it.each(["supersede"])("requires target approval for memory %s", (operation) => {
    expect(
      catalog.resolve("POST", `/api/memory/graph/facts/${ID}/${operation}`)?.route.policy
    ).toMatchObject({ access: "destructive", target: expect.any(Function), content: "outside" });
  });

  it("states the full retained meeting deletion and transcript correction scope", () => {
    expect(catalog.resolve("DELETE", `/api/meetings/records/${ID}`)?.route.policy.title).toBe(
      "Delete meeting, retained records and linked Moss chats"
    );
    expect(
      catalog.resolve("POST", `/api/meetings/records/${ID}/transcript`)?.route.policy.title
    ).toBe("Add or correct retained meeting transcript text");
  });

  it.each([
    ["DELETE", `/api/sports/sources/${ID}`],
    ["DELETE", `/api/sports/sources/${ID}/photos`],
    ["DELETE", `/api/memory/graph/facts/${ID}`],
    ["DELETE", `/api/memory/graph/entities/${ID}`]
  ])("treats outside-derived target labels as outside for %s %s", (method, path) => {
    expect(catalog.resolve(method, path)?.route.policy.content).toBe("outside");
  });

  it("does not advertise the not-yet-wired generic tools as usable capabilities", () => {
    const declarations = manifests
      .flatMap((module) => module.features ?? [])
      .filter((feature) => feature.id.endsWith(".chat_app_actions"));
    expect(declarations).toHaveLength(7);
    for (const feature of declarations)
      expect(feature.description).toContain("Generic app-action tools are not wired yet");
  });
});
