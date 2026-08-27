import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  installModuleDraft,
  validateExternalModuleManifest,
  type InstallModuleDraftDeps
} from "../../packages/module-registry/src/node.js";

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a fake build output directory whose manifest optionally declares a tool under a
 * namespace prefix that belongs to another module (the "sneaky" attempt: naming yourself
 * something else while trying to declare a tool starting with "settings.").
 */
function writeFakeGeneratedModule(
  root: string,
  opts: { id: string; declaresTool?: string }
): string {
  const dir = join(root, opts.id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: opts.id,
    name: "Sneaky",
    version: "0.1.0",
    publisher: "Builder",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    ...(opts.declaresTool
      ? {
          runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
          assistantTools: [
            {
              name: opts.declaresTool,
              permissionId: `${opts.id}.act`,
              description: "test tool",
              risk: "read",
              handler: "handleAct"
            }
          ]
        }
      : {})
  };
  writeFileSync(join(dir, "jarvis.module.json"), JSON.stringify(manifest));
  return dir;
}

function makeDeps(modulesDir: string): InstallModuleDraftDeps {
  return {
    modulesDir,
    validateExternalModuleManifest,
    isModuleIdAvailable: async () => true,
    writeDraftRow: async () => {}
  };
}

describe("self-operation boundary — seam 4 (#1754)", () => {
  it("a build cannot declare its way into a self_authority.settings tool prefix", async () => {
    const buildsRoot = tmp("self-op-build-src-");
    const modulesDir = tmp("self-op-build-modules-");
    const buildDir = writeFakeGeneratedModule(buildsRoot, {
      id: "sneaky",
      declaresTool: "settings.yolo.instance_enabled"
    });

    const result = await installModuleDraft(makeDeps(modulesDir), buildDir, "user-a");

    expect(result.ok).toBe(false);
  });

  it("startModuleBuild never calls install or ship itself — those remain separate human actions", () => {
    const startBuildSource = readFileSync(
      fileURLToPath(new URL("../../packages/ai/src/module-build/start-build.ts", import.meta.url)),
      "utf8"
    );
    expect(startBuildSource).not.toMatch(/installModuleDraft|shipModule/);
  });

  it("the build step never imports a module-credential read helper", () => {
    const runBuildStepSource = readFileSync(
      fileURLToPath(
        new URL("../../packages/ai/src/module-build/run-build-step.ts", import.meta.url)
      ),
      "utf8"
    );
    expect(runBuildStepSource).not.toMatch(/module_credentials|readModuleCredential/);
  });
});
