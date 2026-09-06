import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { emitVirtualModule, scanModuleSettings } from "../../packages/settings-ui/src/vite.js";

let roots: string[] = [];

async function makePackage(
  rootDir: string,
  dirName: string,
  packageName: string,
  manifestBody: string
) {
  const packageDir = join(rootDir, "packages", dirName);
  await mkdir(join(packageDir, "src"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, type: "module" }),
    "utf8"
  );
  await writeFile(join(packageDir, "src", "manifest.ts"), manifestBody, "utf8");
}

async function makeRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "moss-module-settings-"));
  roots.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("module settings scanner", () => {
  it("keeps declarative surfaces and emits component imports only for entries", async () => {
    const rootDir = await makeRoot();
    await makePackage(
      rootDir,
      "fixture",
      "@moss/fixture",
      `export const fixtureModuleManifest = {
        id: "fixture",
        name: "Fixture",
        settings: [
          {
            id: "fixture.settings",
            label: "Fixture",
            description: "Configure the fixture module.",
            path: "/settings/modules/fixture",
            scope: "user",
            order: 10,
            entry: "./settings"
          }
        ]
      };`
    );
    await makePackage(
      rootDir,
      "declarative",
      "@moss/declarative",
      `export const declarativeModuleManifest = {
        id: "declarative",
        name: "Declarative",
        settings: [
          {
            id: "declarative.settings",
            label: "Declarative",
            description: "Configure the declarative module.",
            path: "/settings/modules/declarative",
            scope: "user"
          }
        ]
      };`
    );

    const result = scanModuleSettings({ rootDir });

    expect(result.surfaces).toEqual([
      {
        moduleId: "declarative",
        moduleName: "Declarative",
        id: "declarative.settings",
        label: "Declarative",
        description: "Configure the declarative module.",
        path: "/settings/modules/declarative",
        scope: "user",
        order: null,
        hasEntry: false
      },
      {
        moduleId: "fixture",
        moduleName: "Fixture",
        id: "fixture.settings",
        label: "Fixture",
        description: "Configure the fixture module.",
        path: "/settings/modules/fixture",
        scope: "user",
        order: 10,
        hasEntry: true
      }
    ]);
    expect(result.components.fixture).toContain('import("@moss/fixture/settings")');
    expect(result.components.declarative).toBeUndefined();
  });

  it("throws when two modules claim the same settings path", async () => {
    const rootDir = await makeRoot();
    const manifest = (moduleId: string) => `export const manifest = {
      id: "${moduleId}",
      name: "${moduleId}",
      settings: [
        {
          id: "${moduleId}.settings",
          label: "${moduleId}",
          path: "/settings/modules/fixture",
          scope: "user",
          entry: "./settings"
        }
      ]
    };`;
    await makePackage(rootDir, "fixture-one", "@moss/fixture-one", manifest("one"));
    await makePackage(rootDir, "fixture-two", "@moss/fixture-two", manifest("two"));

    expect(() => scanModuleSettings({ rootDir })).toThrow(
      /duplicate settings path "\/settings\/modules\/fixture"/i
    );
  });

  it("emits the virtual module exports consumed by web", async () => {
    const rootDir = await makeRoot();
    await makePackage(
      rootDir,
      "fixture",
      "@moss/fixture",
      `export const fixtureModuleManifest = {
        id: "fixture",
        name: "Fixture",
        settings: [
          {
            id: "fixture.settings",
            label: "Fixture",
            path: "/settings/modules/fixture",
            scope: "user",
            entry: "settings"
          }
        ]
      };`
    );

    const moduleSource = emitVirtualModule(scanModuleSettings({ rootDir }));

    expect(moduleSource).toContain("export const MODULE_SETTINGS_SURFACES");
    expect(moduleSource).toContain("export const MODULE_SETTINGS_COMPONENTS");
    expect(moduleSource).toContain('lazy(() => import("@moss/fixture/settings"))');
  });
});
