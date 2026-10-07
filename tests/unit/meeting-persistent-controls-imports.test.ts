import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { scanModuleWeb } from "../../packages/settings-ui/src/vite.js";

async function runtimeImports(entry: string) {
  const result = await build({
    entryPoints: [`packages/meetings/src/web/${entry}`],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    packages: "external",
    outdir: "/tmp/moss-controls-import-graph",
    logLevel: "silent"
  });
  return Object.keys(result.metafile.inputs).sort();
}

describe("Meetings persistent controls entry", () => {
  it("is discovered separately and cannot load full screens or their styles", async () => {
    const registry = scanModuleWeb({ rootDir: process.cwd() });
    expect(registry.persistentControls).toEqual({
      meetings: '() => import("@moss/meetings/web/persistent-controls")'
    });
    const imports = await runtimeImports("persistent-controls.tsx");
    expect(
      imports.filter((file) => file.endsWith(".tsx") && !file.startsWith("packages/ui/"))
    ).toEqual([
      "packages/meetings/src/web/capture-controls.tsx",
      "packages/meetings/src/web/capture-strip.tsx",
      "packages/meetings/src/web/persistent-controls.tsx"
    ]);
    expect(imports.filter((file) => file.endsWith(".css"))).toEqual([
      "packages/meetings/src/web/capture-controls.css"
    ]);
    expect(imports).toContain("packages/meetings/src/web/capture-session.ts");
    expect(imports).toContain("packages/meetings/src/web/transcript-time.ts");
    // Sanity: the old full entry really does reach the screen and broad stylesheet.
    const fullEntryImports = await runtimeImports("index.tsx");
    expect(fullEntryImports).toContain("packages/meetings/src/web/meetings-page.tsx");
    expect(fullEntryImports).toContain("packages/meetings/src/web/styles.css");
  });
});
