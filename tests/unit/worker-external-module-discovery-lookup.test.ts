import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExternalModuleDiscoveryHolder } from "../../packages/module-registry/src/node.js";
import { buildDiscoveryLookup } from "../../apps/worker/src/external-module-discovery.js";

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

describe("buildDiscoveryLookup (#1752)", () => {
  it("finds a module added after the holder was created, once rescanned", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "jarvis-worker-modules-"));
    try {
      const holder = createExternalModuleDiscoveryHolder({ modulesDir });
      const lookup = buildDiscoveryLookup(holder);
      expect(lookup("late-module")).toBeUndefined();

      writeMinimalModule(modulesDir, "late-module");
      expect(lookup("late-module")).toBeUndefined(); // still stale until rescan

      await holder.rescan();

      expect(lookup("late-module")?.id).toBe("late-module");
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });

  it("returns undefined for an id that was never discovered", async () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "jarvis-worker-modules-"));
    try {
      const holder = createExternalModuleDiscoveryHolder({ modulesDir });
      const lookup = buildDiscoveryLookup(holder);
      expect(lookup("never-existed")).toBeUndefined();
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });
});
