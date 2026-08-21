import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExternalModuleDiscoveryHolder } from "../../packages/module-registry/src/node.js";

function writeMinimalModule(modulesDir: string, id: string) {
  const dir = join(modulesDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "jarvis.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      publisher: "test",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" }
    })
  );
}

describe("createExternalModuleDiscoveryHolder", () => {
  it("returns a snapshot taken at rescan time, not at construction time", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "jarvis-modules-"));
    try {
      const holder = createExternalModuleDiscoveryHolder({ modulesDir });
      expect(holder.getDiscoveries()).toHaveLength(0);

      writeMinimalModule(modulesDir, "late-module");
      expect(holder.getDiscoveries()).toHaveLength(0); // still stale until rescan

      const result = await holder.rescan();
      expect(result.discoveries.map((d) => d.id)).toContain("late-module");
      expect(holder.getDiscoveries().map((d) => d.id)).toContain("late-module");
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });
});
