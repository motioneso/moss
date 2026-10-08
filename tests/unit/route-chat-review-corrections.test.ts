import { describe, expect, it } from "vitest";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import { buildRouteCatalog } from "../../packages/module-registry/src/route-catalog.js";

const ID = "00000000-0000-4000-8000-000000000001";
const manifests = getBuiltInModuleManifests();
const catalog = buildRouteCatalog(manifests, []);

describe("slice 4 review corrections", () => {
  it("keeps user-only action permissions blocked even with permissive route metadata", () => {
    const settings = manifests.find((module) => module.id === "settings")!;
    const route = settings.routes!.find(
      (route) => route.method === "PUT" && route.path === "/api/me/yolo"
    )!;
    const combined = buildRouteCatalog(
      [
        {
          ...settings,
          routes: [
            {
              ...route,
              chat: {
                access: "write",
                title: "Change action permissions",
                content: "user_authored"
              }
            }
          ]
        }
      ],
      []
    );
    expect(combined.resolve("PUT", "/api/me/yolo")?.route.policy).toMatchObject({
      access: "blocked",
      blockedBecause: "self_authority"
    });
  });

  it("lists final pre-run unavailability and its recovery on app.callAction", () => {
    const feature = manifests
      .find((module) => module.id === "settings")!
      .features!.find((entry) => entry.id === "app.callAction")!;
    expect(feature.errors).toContainEqual(expect.objectContaining({ code: "not_ready" }));
    expect(feature.remediations).toContainEqual(
      expect.objectContaining({ id: "app.retry_ready_action" })
    );
  });
  it.each([
    ["ai", "GET", "/api/ai/activity-lines"],
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

  it("requires target approval when a memory fact edit can end or stale recall", () => {
    expect(catalog.resolve("PATCH", `/api/memory/graph/facts/${ID}`)?.route.policy).toMatchObject({
      access: "destructive",
      target: expect.any(Function),
      content: "outside",
      title: "Change memory dates and recall visibility"
    });
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

  it("declares every newly callable content module truthfully when generic tools are wired", () => {
    const contentModules = new Set([
      "tasks",
      "calendar",
      "memory",
      "wellness",
      "jarvis.goals",
      "jarvis.commitments",
      "scratchpad",
      "email",
      "meetings",
      "news",
      "people",
      "sports",
      "weather",
      "workshop",
      "briefings",
      "notes"
    ]);
    for (const manifest of manifests.filter((module) => contentModules.has(module.id))) {
      const callable = catalog.routes.some(
        (route) => route.moduleId === manifest.id && route.policy.access !== "blocked"
      );
      const feature = manifest.features?.find((item) => item.id.endsWith(".chat_app_actions"));
      expect(Boolean(feature), manifest.id).toBe(callable);
      if (feature) {
        expect(feature.description).toContain("App actions");
        expect(feature.description).not.toContain("not wired yet");
      }
    }
  });
});
