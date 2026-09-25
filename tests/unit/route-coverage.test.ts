import { describe, expect, it } from "vitest";

import { getBuiltInModuleManifests } from "@moss/module-registry";
import { CORE_APP_SETTINGS } from "@moss/shared";

function manifestPaths(id: string): { method: string; path: string }[] {
  const manifest = getBuiltInModuleManifests().find((m) => m.id === id);
  if (!manifest) throw new Error(`no manifest for ${id}`);
  return (manifest.routes ?? []).map((r) => ({ method: r.method, path: r.path }));
}

describe("manifest routes[] reconciliation", () => {
  it("tasks manifest declares preferences + subtasks + activity GET routes", () => {
    const paths = manifestPaths("tasks");
    expect(paths).toContainEqual({ method: "GET", path: "/api/tasks/preferences" });
    expect(paths).toContainEqual({ method: "PATCH", path: "/api/tasks/preferences" });
    expect(paths).toContainEqual({ method: "GET", path: "/api/tasks/agency-auto-execute" });
    expect(paths).toContainEqual({ method: "PATCH", path: "/api/tasks/agency-auto-execute" });
    expect(paths).toContainEqual({ method: "GET", path: "/api/tasks/:id/subtasks" });
    expect(paths).toContainEqual({ method: "GET", path: "/api/tasks/:id/activity" });

    const manifest = getBuiltInModuleManifests().find((m) => m.id === "tasks");
    expect(manifest?.settings?.[0]?.entry).toBe("./settings");
  });

  it("core owns the personal priority surface and settings declares preference routes", () => {
    expect(CORE_APP_SETTINGS).toContainEqual(
      expect.objectContaining({
        id: "priorities",
        label: "Priorities",
        path: "/settings?section=priorities",
        scope: "user"
      })
    );
    const manifest = getBuiltInModuleManifests().find((m) => m.id === "settings");
    expect((manifest?.settings ?? []).map((surface) => surface.id)).not.toContain(
      "priority-settings"
    );

    const paths = manifestPaths("settings");
    expect(paths).toContainEqual({ method: "GET", path: "/api/me/source-behaviors" });
    expect(paths).toContainEqual({ method: "PUT", path: "/api/me/source-behaviors/:id" });
    expect(paths).toContainEqual({ method: "GET", path: "/api/me/priority-model" });
    expect(paths).toContainEqual({ method: "PATCH", path: "/api/me/priority-model" });
  });

  it("chat manifest declares every chat API route the routes module registers", () => {
    const paths = manifestPaths("chat");
    for (const expected of [
      { method: "POST", path: "/api/chat/turn" },
      { method: "POST", path: "/api/chat/attachments" },
      { method: "POST", path: "/api/chat/turn/cancel" },
      { method: "GET", path: "/api/chat/stream" },
      { method: "POST", path: "/api/chat/clear" },
      { method: "POST", path: "/api/chat/private/end" },
      { method: "POST", path: "/api/chat/switch" },
      { method: "GET", path: "/api/chat/threads" },
      { method: "GET", path: "/api/chat/memory/settings" },
      { method: "PATCH", path: "/api/chat/memory/settings" },
      { method: "GET", path: "/api/chat/memory/facts" },
      { method: "DELETE", path: "/api/chat/memory/facts/:id" },
      { method: "PATCH", path: "/api/chat/memory/facts/:id" },
      { method: "POST", path: "/api/chat/memory/facts/:id/confirm" },
      { method: "POST", path: "/api/chat/memory/facts/:id/reject" },
      { method: "GET", path: "/api/chat/memory/corrections" },
      { method: "POST", path: "/api/chat/action-requests/:id/resolve" },
      { method: "POST", path: "/api/mcp" },
      { method: "POST", path: "/internal/permission" }
    ]) {
      expect(paths).toContainEqual(expected);
    }
  });

  it("memory manifest declares graph API routes", () => {
    const paths = manifestPaths("memory");
    for (const expected of [
      { method: "GET", path: "/api/memory/graph/recall" },
      { method: "GET", path: "/api/memory/graph/core" },
      { method: "POST", path: "/api/memory/graph/entities" },
      { method: "POST", path: "/api/memory/graph/facts" },
      { method: "POST", path: "/api/memory/graph/facts/:id/pin" },
      { method: "POST", path: "/api/memory/graph/facts/:id/confirm" },
      { method: "POST", path: "/api/memory/graph/facts/:id/correct" },
      { method: "POST", path: "/api/memory/graph/facts/:id/status" },
      { method: "POST", path: "/api/memory/graph/facts/:id/mark-stale" },
      { method: "POST", path: "/api/memory/graph/facts/:id/supersede" },
      { method: "DELETE", path: "/api/memory/graph/facts/:id" }
    ]) {
      expect(paths).toContainEqual(expected);
    }
  });

  it("connectors manifest declares the Google OAuth POST routes", () => {
    const paths = manifestPaths("connectors");
    expect(paths).toContainEqual({ method: "POST", path: "/api/connectors/google/authorize" });
    expect(paths).toContainEqual({ method: "POST", path: "/api/connectors/google/complete" });
  });

  it("every manifest API route uses Fastify :param syntax (not {param})", () => {
    for (const manifest of getBuiltInModuleManifests()) {
      for (const route of manifest.routes ?? []) {
        expect(route.path).not.toMatch(/\{.*\}/);
      }
    }
  });
});
