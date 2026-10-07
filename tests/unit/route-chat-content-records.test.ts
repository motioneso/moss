import { describe, expect, it } from "vitest";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";
import {
  RECORDS_EXPECTED_ROWS,
  RECORDS_MODULE_IDS,
  RECORDS_NAMED_BLOCKED
} from "../fixtures/route-chat-content-records.js";

const manifests = () => getBuiltInModuleManifests().filter((m) => RECORDS_MODULE_IDS.has(m.id));
const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000001");

describe("record, mail and weather chat policies", () => {
  it("classifies every route explicitly", () => {
    expect(() => assertRouteChatClassification(manifests())).not.toThrow();
    const catalog = buildRouteCatalog(manifests(), []);
    const rows = catalog.routes.map((route) =>
      [
        route.moduleId,
        route.method,
        route.path,
        route.policy.access,
        route.policy.blockedBecause,
        route.policy.content === "user_authored" ? "user_authored" : undefined,
        route.policy.outbound ? "outbound" : undefined
      ]
        .filter(Boolean)
        .join(" ")
    );
    expect(rows.sort()).toEqual([...RECORDS_EXPECTED_ROWS].sort());
  });
  it.each(RECORDS_NAMED_BLOCKED)("blocks %s %s as %s", (method, path, category) => {
    const found = buildRouteCatalog(manifests(), []).resolve(method, concrete(path));
    expect(found?.route.path).toBe(path);
    expect(found?.route.policy).toMatchObject({ access: "blocked", blockedBecause: category });
  });
  it("names the exact meeting or project being deleted", () => {
    for (const path of ["/api/meetings/records/:id", "/api/workshop/projects/:projectId"]) {
      const found = buildRouteCatalog(manifests(), []).resolve("DELETE", concrete(path));
      expect(found?.route.policy).toMatchObject({
        access: "destructive",
        target: expect.any(Function)
      });
    }
  });
  it("keeps saved notes, transcripts, project context and mail outside", () => {
    const catalog = buildRouteCatalog(manifests(), []);
    for (const [method, path] of [
      ["PUT", "/api/meetings/records/:id/notes"],
      ["GET", "/api/meetings/records/:id/transcript"],
      ["PATCH", "/api/workshop/projects/:projectId"],
      ["GET", "/api/email/messages/:id"]
    ]) {
      expect(catalog.resolve(method!, concrete(path!))?.route.policy.content).toBe("outside");
    }
  });
});
