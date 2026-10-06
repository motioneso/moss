import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CatalogRoute, RouteCatalog, ToolContext } from "@moss/module-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appCallActionExecute,
  appFindActionExecute,
  appReadSourceExecute,
  createAppReadSourceExecute,
  findAppInstallRoot
} from "./app-action-tools.js";
import { settingsModuleManifest } from "./manifest.js";

const ctx: ToolContext = { actorUserId: "actor", requestId: "request", chatSessionId: "chat" };
const route: CatalogRoute = {
  method: "PUT",
  path: "/api/me/themes/mode",
  moduleId: "settings",
  policy: {
    access: "write",
    title: "Change color mode",
    content: "user_authored",
    coveredBy: "settings.themeMode.set"
  },
  inputShape: { body: { type: "object", properties: { mode: { type: "string" } } } }
};

function catalogWith(routes: readonly CatalogRoute[]) {
  const search = vi.fn(() => routes);
  const catalog: RouteCatalog = { routes, search, resolve: vi.fn(() => null) };
  return { catalog, search };
}

describe("app.findAction", () => {
  it("searches the read service and projects only declared route metadata", async () => {
    const blocked: CatalogRoute = {
      ...route,
      method: "PATCH",
      path: "/api/admin/settings/:key",
      policy: { access: "blocked", blockedBecause: "self_authority", content: "outside" },
      inputShape: null
    };
    const { catalog, search } = catalogWith([route, blocked]);
    const call = vi.fn();
    const result = await appFindActionExecute(null, { query: " themes " }, ctx, {
      appCatalog: { catalog: () => catalog },
      appActions: { call }
    });
    expect(search).toHaveBeenCalledWith("themes", 8);
    expect(result.data).toEqual({
      actions: [
        {
          method: "PUT",
          path: route.path,
          module: "settings",
          access: "write",
          title: "Change color mode",
          inputShape: route.inputShape,
          coveredBy: "settings.themeMode.set"
        },
        {
          method: "PATCH",
          path: blocked.path,
          module: "settings",
          access: "blocked",
          title: null,
          inputShape: null,
          coveredBy: null,
          category: "self_authority"
        }
      ]
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("passes the bounded explicit limit", async () => {
    const { catalog, search } = catalogWith([]);
    await appFindActionExecute(null, { query: "mode", limit: 20 }, ctx, {
      appCatalog: { catalog: () => catalog }
    });
    expect(search).toHaveBeenCalledWith("mode", 20);
  });

  it.each([undefined, null, {}, { catalog: true }, { call: vi.fn() }, "catalog"])(
    "refuses malformed or absent catalog service %#",
    async (appCatalog) => {
      await expect(
        appFindActionExecute(null, { query: "mode" }, ctx, { appCatalog })
      ).rejects.toThrow("appCatalog service is unavailable");
    }
  );

  it("never falls back to a catalog on the write service", async () => {
    const catalog = vi.fn(() => catalogWith([]).catalog);
    await expect(
      appFindActionExecute(null, { query: "mode" }, ctx, { appActions: { catalog } })
    ).rejects.toThrow("appCatalog service is unavailable");
    expect(catalog).not.toHaveBeenCalled();
  });

  it("refuses an empty holder as not_ready", async () => {
    await expect(
      appFindActionExecute(null, { query: "mode" }, ctx, { appCatalog: { catalog: () => null } })
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it.each([{ query: " " }, { query: "mode", limit: 0 }, { query: "mode", limit: 21 }])(
    "rejects invalid search input before calling a service: %j",
    async (input) => {
      const catalog = vi.fn();
      await expect(
        appFindActionExecute(null, input, ctx, { appCatalog: { catalog } })
      ).rejects.toThrow();
      expect(catalog).not.toHaveBeenCalled();
    }
  );
});

describe("app.callAction", () => {
  it("calls only the write service with validated input and context and preserves the response", async () => {
    const input = {
      method: "PATCH",
      path: "/api/me/locale",
      query: { view: "full" },
      body: { timezone: "UTC" }
    };
    const response = { status: 200, body: { locale: { timezone: "UTC" } } };
    const call = vi.fn(async (_input: unknown, _ctx: ToolContext) => response);
    const result = await appCallActionExecute(null, input, ctx, { appActions: { call } });
    expect(call).toHaveBeenCalledExactlyOnceWith(input, ctx);
    expect(call.mock.calls[0]?.[0]).toBe(input);
    expect(call.mock.calls[0]?.[1]).toBe(ctx);
    expect(result).toEqual({ data: response });
  });

  it.each([400, 403, 404, 422, 500, 503])(
    "marks HTTP %i as a failed tool result without altering the response body",
    async (status) => {
      const body = { error: "The route refused this action", details: { field: "mode" } };
      const call = vi.fn(async () => ({ status, body }));
      const result = await appCallActionExecute(
        null,
        { method: "PUT", path: "/api/me/themes/mode", body: { mode: "invalid" } },
        ctx,
        { appActions: { call } }
      );
      expect(result.data).toEqual({ status, body, ok: false });
      expect(result.data.body).toBe(body);
    }
  );

  it.each([undefined, null, {}, { call: true }, { catalog: vi.fn() }, "call"])(
    "refuses malformed or absent write service %#",
    async (appActions) => {
      await expect(
        appCallActionExecute(null, { method: "GET", path: "/api/me" }, ctx, { appActions })
      ).rejects.toThrow("appActions service is unavailable");
    }
  );

  it("never falls back to a write capability on the read service", async () => {
    const call = vi.fn();
    await expect(
      appCallActionExecute(null, { method: "GET", path: "/api/me" }, ctx, {
        appCatalog: { call, catalog: () => null }
      })
    ).rejects.toThrow("appActions service is unavailable");
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { method: "OPTIONS", path: "/api/me" },
    { method: "GET", path: "https://example.test/api/me" },
    { method: "GET", path: "/api/me", query: { full: true } },
    { method: "GET", path: "/api/me", headers: { cookie: "not-a-real-cookie" } }
  ])("rejects invalid call input before invoking the write service: %j", async (input) => {
    const call = vi.fn();
    await expect(
      appCallActionExecute(null, input, ctx, { appActions: { call } })
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("app.readSource", () => {
  let fixture: string;
  let root: string;
  let readSource: ReturnType<typeof createAppReadSourceExecute>;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "moss-app-source-"));
    root = join(fixture, "install");
    await mkdir(join(root, "packages/example/src"), { recursive: true });
    await mkdir(join(root, "apps/web/src"), { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(
      join(root, "packages/example/src/routes.ts"),
      Array.from({ length: 600 }, (_, n) => `line ${n + 1}`).join("\n") + "\n"
    );
    readSource = createAppReadSourceExecute(root);
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads at most 400 lines with inclusive line numbers", async () => {
    const { data } = await readSource(
      null,
      { path: "packages/example/src/routes.ts", startLine: 5, endLine: 600 },
      ctx
    );
    expect(data).toMatchObject({
      path: "packages/example/src/routes.ts",
      startLine: 5,
      endLine: 404
    });
    expect(String(data.text).split("\n")).toHaveLength(400);
    expect(String(data.text)).toMatch(/^line 5\n/);
    expect(String(data.text)).toMatch(/line 404$/);
  });

  it.each([".ts", ".tsx", ".json", ".md"])(
    "allows %s files in app source roots",
    async (extension) => {
      const path = `apps/web/src/example${extension}`;
      await writeFile(join(root, path), "first\nsecond\n");
      const { data } = await readSource(null, { path, startLine: 2, endLine: 2 }, ctx);
      expect(data).toEqual({ path, startLine: 2, endLine: 2, text: "second" });
    }
  );

  it.each([
    "../outside.ts",
    "packages/example/src/../outside.ts",
    "packages/example/src/../../example/src/routes.ts",
    "packages/example/routes.ts",
    "apps/web/routes.ts",
    "docs/example.ts",
    "packages/example/src/.env",
    "packages/example/src/.env.json",
    "packages/example/src/.env/routes.ts",
    "packages/example/src/example.js"
  ])("refuses disallowed source path %s", async (path) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "source boundary sentinel");
    await expect(readSource(null, { path }, ctx)).rejects.toMatchObject({
      code: "source_path_not_allowed"
    });
  });

  it("refuses absolute paths", async () => {
    await expect(
      readSource(null, { path: join(root, "packages/example/src/routes.ts") }, ctx)
    ).rejects.toMatchObject({ code: "source_path_not_allowed" });
  });

  it("refuses a file symlink outside its source root", async () => {
    await writeFile(join(root, "private.ts"), "outside root sentinel");
    await symlink(join(root, "private.ts"), join(root, "packages/example/src/link.ts"));
    await expect(
      readSource(null, { path: "packages/example/src/link.ts" }, ctx)
    ).rejects.toMatchObject({ code: "source_path_not_allowed" });
  });

  it("refuses a source-root symlink outside the install root", async () => {
    await mkdir(join(fixture, "outside"));
    await writeFile(join(fixture, "outside/private.ts"), "outside install sentinel");
    await symlink(join(fixture, "outside"), join(root, "apps/web/src/escape"));
    await expect(
      readSource(null, { path: "apps/web/src/escape/private.ts" }, ctx)
    ).rejects.toMatchObject({ code: "source_path_not_allowed" });
  });

  it("refuses replacing src itself with a symlink to another directory", async () => {
    await mkdir(join(root, "packages/linked"));
    await symlink(join(root, "packages/example/src"), join(root, "packages/linked/src"));
    await expect(
      readSource(null, { path: "packages/linked/src/routes.ts" }, ctx)
    ).rejects.toMatchObject({ code: "source_path_not_allowed" });
  });

  it("refuses allowed-looking symlinks to a disallowed extension", async () => {
    await writeFile(join(root, "packages/example/src/secret.js"), "extension sentinel");
    await symlink("secret.js", join(root, "packages/example/src/alias.ts"));
    await expect(
      readSource(null, { path: "packages/example/src/alias.ts" }, ctx)
    ).rejects.toMatchObject({ code: "source_path_not_allowed" });
  });

  it.each([{ startLine: 0 }, { startLine: 3, endLine: 2 }, { endLine: 0 }, { startLine: 1.5 }])(
    "refuses invalid line ranges %j",
    async (range) => {
      await expect(
        readSource(null, { path: "packages/example/src/routes.ts", ...range }, ctx)
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  );

  it("does not expose absolute paths in filesystem errors", async () => {
    await expect(
      readSource(null, { path: "packages/example/src/missing.ts" }, ctx)
    ).rejects.toMatchObject({ code: "source_unavailable" });
    await expect(
      readSource(null, { path: "packages/example/src/missing.ts" }, ctx)
    ).rejects.not.toThrow(root);
  });

  it("finds the running install from source and bundled runtime locations", async () => {
    await mkdir(join(root, "dist"));
    expect(findAppInstallRoot(join(root, "packages/example/src"))).toBe(root);
    expect(findAppInstallRoot(join(root, "dist"))).toBe(root);
  });

  it("uses the running installation by default, independent of cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { data } = await appReadSourceExecute(
      null,
      { path: "packages/settings/src/app-action-tools.ts", endLine: 1 },
      ctx
    );
    expect(data.path).toBe("packages/settings/src/app-action-tools.ts");
    expect(data.endLine).toBe(1);
  });
});

describe("app action declarations", () => {
  const names = ["app.findAction", "app.readSource", "app.callAction"];
  it("declares all three tools with under 150 words of combined description", () => {
    const tools =
      settingsModuleManifest.assistantTools?.filter((tool) => names.includes(tool.name)) ?? [];
    expect(tools).toHaveLength(3);
    expect(
      tools
        .map((tool) => tool.description)
        .join(" ")
        .trim()
        .split(/\s+/).length
    ).toBeLessThan(150);
    expect(tools.find((tool) => tool.name === "app.findAction")).toMatchObject({
      risk: "read",
      requiresServices: ["appCatalog"]
    });
    expect(tools.find((tool) => tool.name === "app.callAction")).toMatchObject({
      risk: "write",
      requiresServices: ["appActions"],
      selfOperationGrant: "confirm_always"
    });
  });

  it("marks dedicated own-record and status-only writes user_authored", () => {
    for (const name of [
      "settings.themeMode.set",
      "settings.locale.setTimezone",
      "settings.locale.setRegionAndDateFormat",
      "settings.quietHours.set",
      "settings.undoLast",
      "settings.notificationPreference.setEnabled"
    ]) {
      expect(
        settingsModuleManifest.assistantTools?.find((tool) => tool.name === name)?.content
      ).toBe("user_authored");
    }
    // Geocoding returns provider-supplied place text rather than only an own-record status.
    expect(
      settingsModuleManifest.assistantTools?.find(
        (tool) => tool.name === "settings.weatherLocation.set"
      )?.content
    ).not.toBe("user_authored");
  });

  it("declares discoverability and source refusal recovery in the app map", () => {
    const features = settingsModuleManifest.features ?? [];
    expect(features.map((feature) => feature.id)).toEqual(expect.arrayContaining(names));
    const source = features.find((feature) => feature.id === "app.readSource");
    expect(source?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source_path_not_allowed"
        })
      ])
    );
    expect(source?.remediations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "app.source_path" })])
    );
  });
});
