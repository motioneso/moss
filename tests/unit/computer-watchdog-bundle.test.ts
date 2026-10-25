import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWatchdogBundle,
  bundleWatchdog
} from "../../scripts/computer-watchdog/bundle.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundle-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

describe("watchdog bundle", () => {
  it("covers the files the entry imports, so a change to one changes the pinned hash", async () => {
    const a = await tree({
      "entry.ts": 'import { v } from "./dep.js"; console.log(v);',
      "dep.ts": "export const v = 1;"
    });
    const b = await tree({
      "entry.ts": 'import { v } from "./dep.js"; console.log(v);',
      "dep.ts": "export const v = 2;"
    });
    const first = await bundleWatchdog(a, "entry.ts");
    const second = await bundleWatchdog(b, "entry.ts");
    expect(first.sha256).not.toBe(second.sha256);
    expect(first.bytes.toString()).not.toMatch(/dep\.js/);
  });

  it("fails when an import cannot be bundled", async () => {
    const root = await tree({ "entry.ts": 'import "left-pad-not-here";' });
    await expect(bundleWatchdog(root, "entry.ts")).rejects.toThrow();
  });

  it("keeps Node builtins external and bundles the real watchdog code", async () => {
    const built = await buildWatchdogBundle();
    const text = built.bytes.toString();
    expect(text).toContain("assertHoldDescriptors");
    expect(text).toContain("runWatchdog");
    expect(text).not.toMatch(/require\("\.{1,2}\//);
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
