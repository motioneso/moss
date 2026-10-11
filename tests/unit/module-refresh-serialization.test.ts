import Fastify from "fastify";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { listModulesRouteSchema, type ModuleDto } from "@moss/shared";
import { describe, expect, it } from "vitest";

import { serializeModule } from "../../apps/api/src/module-dto.js";

describe("module refresh declarations over HTTP", () => {
  it("preserves manifest refresh tokens through the actual modules response serializer", async () => {
    const app = Fastify();
    const manifests = getBuiltInModuleManifests();
    app.get("/modules", { schema: listModulesRouteSchema }, () => ({
      modules: manifests.map(serializeModule)
    }));
    try {
      const response = await app.inject("/modules");
      expect(response.statusCode).toBe(200);
      const { modules } = response.json<{ modules: ModuleDto[] }>();
      const withTokens = manifests.filter((module) => (module.chatRefreshTokens?.length ?? 0) > 0);
      expect(withTokens.map((module) => module.id)).toEqual(
        expect.arrayContaining(["settings", "jarvis.goals", "notes"])
      );
      for (const manifest of withTokens) {
        expect(
          modules.find((module) => module.id === manifest.id)?.chatRefreshTokens,
          manifest.id
        ).toEqual(manifest.chatRefreshTokens);
      }
      expect(modules.find((module) => module.id === "news")?.chatRefreshTokens).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
