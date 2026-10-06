import { describe, expect, it } from "vitest";

import type {
  ModuleAssistantToolManifest,
  ModuleRouteManifest,
  MossModuleManifest,
  RouteChatPolicy
} from "@moss/module-sdk";

import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  CHAT_BLOCKED_PATH_RULES,
  assertReadToolContentDeclared,
  assertRouteChatClassification,
  buildRouteCatalog,
  createRouteCatalogHolder,
  findUnmappedJulyPrefixes,
  type RouteChatRuleTables
} from "../../packages/module-registry/src/route-catalog.js";

function manifest(
  id: string,
  routes: readonly ModuleRouteManifest[],
  extra: Partial<MossModuleManifest> = {}
): MossModuleManifest {
  return {
    id,
    name: id,
    version: "0.1.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    routes,
    ...extra
  };
}

function route(
  method: ModuleRouteManifest["method"],
  path: string,
  chat?: RouteChatPolicy
): ModuleRouteManifest {
  return chat ? { method, path, chat } : { method, path };
}

const read: RouteChatPolicy = { access: "read" };
const write = (title = "Change it"): RouteChatPolicy => ({ access: "write", title });

const target = async () => "Ocean";

const themes = manifest("settings", [
  route("GET", "/api/me/themes", read),
  route("PUT", "/api/me/themes/mode", write("Switch light or dark")),
  route("PUT", "/api/me/themes/:id", write("Edit a theme")),
  route("DELETE", "/api/me/themes/:id", {
    access: "destructive",
    title: "Delete a theme",
    target
  }),
  route("GET", "/api/me/weather-unit", read),
  route("POST", "/api/me/themes", write("Create a theme"))
]);

const noTables: RouteChatRuleTables = {
  julyExcludedRoutes: [],
  julyPrefixesWithoutRoutes: [],
  destructiveWordPostAllowlist: []
};

describe("route chat classification assertion", () => {
  it("passes a fully classified synthetic module", () => {
    expect(() => assertRouteChatClassification([themes])).not.toThrow();
  });

  it("fails an unclassified route", () => {
    const m = manifest("notes", [route("GET", "/api/notes")]);
    expect(() => assertRouteChatClassification([m])).toThrow(/GET \/api\/notes.*no chat access/);
  });

  it("classifies through chatDefaults", () => {
    const m = manifest("notes", [route("GET", "/api/notes")], {
      chatDefaults: { access: "read" }
    });
    expect(() => assertRouteChatClassification([m])).not.toThrow();
  });

  it("fails a GET classed write and a DELETE classed read", () => {
    const get = manifest("notes", [route("GET", "/api/notes", write())]);
    expect(() => assertRouteChatClassification([get])).toThrow(/GET \/api\/notes.*GET/);
    const del = manifest("notes", [route("DELETE", "/api/notes/:id", read)]);
    expect(() => assertRouteChatClassification([del])).toThrow(/DELETE \/api\/notes\/:id.*DELETE/);
  });

  it("fails blocked without a category and write without a title", () => {
    const blocked = manifest("notes", [route("POST", "/api/notes", { access: "blocked" })]);
    expect(() => assertRouteChatClassification([blocked])).toThrow(/blockedBecause/);
    const untitled = manifest("notes", [route("POST", "/api/notes", { access: "write" })]);
    expect(() => assertRouteChatClassification([untitled])).toThrow(/title/);
  });

  it("forces an /api/admin/ route blocked in the catalog and fails it in the assertion", () => {
    const m = manifest("settings", [route("POST", "/api/admin/users", write())]);
    const catalog = buildRouteCatalog([m], []);
    expect(catalog.routes[0]?.policy.access).toBe("blocked");
    expect(catalog.routes[0]?.policy.blockedBecause).toBe("self_authority");
    expect(() => assertRouteChatClassification([m])).toThrow(/POST \/api\/admin\/users.*blocked/);
    const declared = manifest("settings", [
      route("POST", "/api/admin/users", { access: "blocked", blockedBecause: "self_authority" })
    ]);
    expect(() => assertRouteChatClassification([declared])).not.toThrow();
  });

  it("forces July families blocked by path pattern", () => {
    const m = manifest("settings", [
      route("PUT", "/api/me/persona", write()),
      route("POST", "/api/me/persona/preview", write()),
      route("POST", "/api/chat/skills/import", write())
    ]);
    const catalog = buildRouteCatalog([m], []);
    for (const r of catalog.routes) {
      expect(r.policy).toMatchObject({ access: "blocked", blockedBecause: "prompt_shaping" });
    }
    expect(() => assertRouteChatClassification([m])).toThrow(/prompt_shaping/);
  });

  it("blocks writes only on a writes-only rule and leaves GET at its declared class", () => {
    const m = manifest("settings", [
      route("GET", "/api/me/modules/:id", read),
      route("PATCH", "/api/me/modules/:id", write())
    ]);
    const catalog = buildRouteCatalog([m], []);
    const byMethod = new Map(catalog.routes.map((r) => [r.method, r.policy]));
    expect(byMethod.get("GET")).toMatchObject({ access: "read" });
    expect(byMethod.get("PATCH")).toMatchObject({
      access: "blocked",
      blockedBecause: "self_authority"
    });
    expect(() => assertRouteChatClassification([m])).toThrow(/PATCH \/api\/me\/modules\/:id/);
    const fixed = manifest("settings", [
      route("GET", "/api/me/modules/:id", read),
      route("PATCH", "/api/me/modules/:id", {
        access: "blocked",
        blockedBecause: "self_authority"
      })
    ]);
    expect(() => assertRouteChatClassification([fixed])).not.toThrow();
  });

  it("fails a July-excluded route that is not blocked with its category", () => {
    const m = manifest("tasks", [route("POST", "/api/tasks/escalate", write())]);
    const tables: RouteChatRuleTables = {
      ...noTables,
      julyExcludedRoutes: [
        {
          method: "POST",
          path: "/api/tasks/escalate",
          category: "self_authority",
          julyPrefixes: ["tasks.escalate."]
        }
      ]
    };
    expect(() => assertRouteChatClassification([m], { tables })).toThrow(
      /POST \/api\/tasks\/escalate.*self_authority/
    );
    expect(buildRouteCatalog([m], [], tables).routes[0]?.policy.access).toBe("blocked");
  });

  it("fails a consent module route without consent", () => {
    const aiConsent = { key: "wellness.ai_consent_granted", isGranted: async () => true };
    const m = manifest("wellness", [route("GET", "/api/wellness/today", read)], { aiConsent });
    expect(() => assertRouteChatClassification([m])).toThrow(/consent/);
    const ok = manifest(
      "wellness",
      [route("GET", "/api/wellness/today", { ...read, consent: "wellness.ai_consent_granted" })],
      { aiConsent }
    );
    expect(() => assertRouteChatClassification([ok])).not.toThrow();
  });

  it("fails a destructive :id route without a target resolver", () => {
    const m = manifest("notes", [
      route("DELETE", "/api/notes/:id", { access: "destructive", title: "Delete a note" })
    ]);
    expect(() => assertRouteChatClassification([m])).toThrow(/target/);
  });

  it("allows outbound only on a GET classed read", () => {
    const post = manifest("settings", [
      route("POST", "/api/me/weather-location", { ...write(), outbound: true })
    ]);
    expect(() => assertRouteChatClassification([post])).toThrow(/outbound/);
    const get = manifest("settings", [
      route("GET", "/api/me/weather-location/search", { ...read, outbound: true })
    ]);
    expect(() => assertRouteChatClassification([get])).not.toThrow();
  });

  it("fails a destructive-word POST classed write unless allowlisted", () => {
    const m = manifest("x", [route("POST", "/api/x/reset", write())]);
    expect(() => assertRouteChatClassification([m], { tables: noTables })).toThrow(
      /POST \/api\/x\/reset.*destructive/
    );
    const tables: RouteChatRuleTables = {
      ...noTables,
      destructiveWordPostAllowlist: [{ path: "/api/x/reset", reason: "resets a view filter" }]
    };
    expect(() => assertRouteChatClassification([m], { tables })).not.toThrow();
  });

  it("fails coveredBy naming a tool that does not exist", () => {
    const tool: ModuleAssistantToolManifest = {
      name: "settings.themeMode.set",
      description: "Set theme mode.",
      permissionId: "settings.manage",
      risk: "write"
    };
    const covered = (name: string) =>
      manifest("settings", [route("PUT", "/api/me/themes/mode", { ...write(), coveredBy: name })], {
        assistantTools: [tool]
      });
    expect(() => assertRouteChatClassification([covered("settings.themeMode.set")])).not.toThrow();
    expect(() => assertRouteChatClassification([covered("settings.nope")])).toThrow(/coveredBy/);
  });
});

describe("route catalog", () => {
  const catalog = buildRouteCatalog([themes], []);

  it("resolves a concrete path to its route and params", () => {
    const hit = catalog.resolve("DELETE", "/api/me/themes/abc");
    expect(hit?.route.path).toBe("/api/me/themes/:id");
    expect(hit?.params).toEqual({ id: "abc" });
    expect(catalog.resolve("DELETE", "/api/me/nothing/abc")).toBeNull();
    expect(catalog.resolve("PATCH", "/api/me/themes/abc")).toBeNull();
  });

  it("prefers a static segment over a parameter", () => {
    expect(catalog.resolve("PUT", "/api/me/themes/mode")?.route.path).toBe("/api/me/themes/mode");
    expect(catalog.resolve("PUT", "/api/me/themes/t1")?.route.path).toBe("/api/me/themes/:id");

    // Declaration order must not decide it.
    const paramFirst = buildRouteCatalog(
      [
        manifest("settings", [
          route("PUT", "/api/me/themes/:id", write("Edit a theme")),
          route("PUT", "/api/me/themes/mode", write("Switch light or dark"))
        ])
      ],
      []
    );
    expect(paramFirst.resolve("PUT", "/api/me/themes/mode")?.route.path).toBe(
      "/api/me/themes/mode"
    );
  });

  it("refuses paths that could route somewhere else", () => {
    for (const path of [
      "/api/me/themes/abc/",
      "/api/me/themes/..",
      "/api/me/themes/.",
      "/api/me/themes/a%2Fb",
      "/api/me/themes/abc?x=1",
      "/api/me/themes/abc#x",
      "/api/me/themes/%E0%A4%A",
      "api/me/themes/abc"
    ]) {
      expect(catalog.resolve("DELETE", path), path).toBeNull();
    }
  });

  it("ranks the theme delete route first for 'delete theme'", () => {
    expect(catalog.search("delete theme", 3)[0]?.path).toBe("/api/me/themes/:id");
    expect(catalog.search("delete theme", 3)[0]?.method).toBe("DELETE");
    expect(catalog.search("delete theme", 2)).toHaveLength(2);
  });

  it("leaves path-rule-blocked routes out of search", () => {
    const m = manifest("settings", [route("POST", "/api/admin/users", write("Add a user"))]);
    expect(buildRouteCatalog([m], []).search("add user", 5)).toEqual([]);
  });

  it("defaults content to outside and keeps unclassified routes out", () => {
    const m = manifest("notes", [route("GET", "/api/notes", read), route("GET", "/api/x")]);
    const built = buildRouteCatalog([m], []);
    expect(built.routes).toHaveLength(1);
    expect(built.routes[0]?.policy.content).toBe("outside");
  });

  it("prefers the captured Fastify schema over the manifest request schema", () => {
    const m = manifest("settings", [
      { ...route("PUT", "/api/me/themes/:id", write()), requestSchema: { type: "object" } },
      { ...route("POST", "/api/me/themes", write()), requestSchema: { type: "array" } }
    ]);
    const built = buildRouteCatalog(
      [m],
      [
        {
          method: "PUT",
          url: "/api/me/themes/:id",
          body: { type: "object", required: ["name"] },
          params: { type: "object" }
        }
      ]
    );
    const byMethod = new Map(built.routes.map((r) => [r.method, r.inputShape]));
    expect(byMethod.get("PUT")).toEqual({
      body: { type: "object", required: ["name"] },
      params: { type: "object" }
    });
    expect(byMethod.get("POST")).toEqual({ body: { type: "array" } });
  });
});

describe("July rules walk", () => {
  it("names a prefix with no blocked route through it, rule by rule", () => {
    const m = manifest("settings", [
      route("PATCH", "/api/me/modules/:id", {
        access: "blocked",
        blockedBecause: "self_authority"
      })
    ]);
    const catalog = buildRouteCatalog([m], []);
    const rules = [
      {
        category: "self_authority" as const,
        toolNamePrefixes: ["settings.module.enable.", "settings.unmapped."]
      }
    ];
    const pathRules = CHAT_BLOCKED_PATH_RULES.map((rule) =>
      rule.pattern.test("/api/me/modules/x")
        ? { ...rule, julyPrefixes: ["settings.module.enable."] }
        : rule
    );
    expect(findUnmappedJulyPrefixes(rules, catalog, { ...noTables, pathRules })).toEqual([
      "settings.unmapped."
    ]);
  });

  it("does not count a prefix whose rule blocks no catalog route", () => {
    const catalog = buildRouteCatalog([manifest("notes", [route("GET", "/api/notes", read)])], []);
    const pathRules = CHAT_BLOCKED_PATH_RULES.map((rule) =>
      rule.pattern.test("/api/me/modules/x") ? { ...rule, julyPrefixes: ["settings.a."] } : rule
    );
    const rules = [{ category: "self_authority" as const, toolNamePrefixes: ["settings.a."] }];
    expect(findUnmappedJulyPrefixes(rules, catalog, { ...noTables, pathRules })).toEqual([
      "settings.a."
    ]);
  });

  it("accepts a prefix listed as having no routes", () => {
    const catalog = buildRouteCatalog([], []);
    const rules = [{ category: "secrets" as const, toolNamePrefixes: ["ai.secret."] }];
    const tables: RouteChatRuleTables = {
      ...noTables,
      julyPrefixesWithoutRoutes: [{ prefix: "ai.secret.", reason: "no route reveals a secret" }]
    };
    expect(findUnmappedJulyPrefixes(rules, catalog, tables)).toEqual([]);
  });
});

describe("read tool content declaration", () => {
  const tool = (extra: Partial<ModuleAssistantToolManifest>): ModuleAssistantToolManifest => ({
    name: "notes.search",
    description: "Search notes.",
    permissionId: "notes.view",
    risk: "read",
    ...extra
  });

  it("fails a built-in read tool with no content", () => {
    expect(() =>
      assertReadToolContentDeclared([manifest("notes", [], { assistantTools: [tool({})] })])
    ).toThrow(/notes\.search.*content/);
  });

  it("fails user_authored together with externalContent", () => {
    const bad = tool({ content: "user_authored", externalContent: true });
    expect(() =>
      assertReadToolContentDeclared([manifest("notes", [], { assistantTools: [bad] })])
    ).toThrow(/notes\.search.*externalContent/);
  });

  it("passes declared tools and needs nothing from external tools", () => {
    const tools = [
      tool({ content: "outside" }),
      tool({ name: "notes.mine", content: "user_authored" }),
      tool({ name: "notes.write", risk: "write" }),
      tool({ name: "ext.read", isExternal: true })
    ];
    expect(() =>
      assertReadToolContentDeclared([manifest("notes", [], { assistantTools: tools })])
    ).not.toThrow();
  });
});

describe("route catalog holder", () => {
  it("returns null before set and throws on a second set", () => {
    const holder = createRouteCatalogHolder();
    expect(holder.get()).toBeNull();
    const catalog = buildRouteCatalog([], []);
    holder.set(catalog);
    expect(holder.get()).toBe(catalog);
    expect(() => holder.set(catalog)).toThrow(/already/);
  });
});

describe("real manifests", () => {
  it("builds a catalog from the built-in manifests", () => {
    const manifests = getBuiltInModuleManifests();
    const total = manifests.reduce((sum, m) => sum + (m.routes?.length ?? 0), 0);
    const catalog = buildRouteCatalog(manifests, []);
    console.log(`route catalog: ${total} manifest routes, ${catalog.routes.length} in catalog`);
    expect(total).toBeGreaterThan(300);
    expect(catalog.routes.length).toBeGreaterThan(0);
    const declaring = new Set(
      manifests
        .filter((m) => m.chatDefaults || (m.routes ?? []).some((route) => route.chat))
        .map((m) => m.id)
    );
    // Routes of modules that declare nothing enter the catalog only when a path rule forces them.
    expect(
      catalog.routes
        .filter((r) => !declaring.has(r.moduleId))
        .every((r) => r.policy.access === "blocked")
    ).toBe(true);
  });
});
