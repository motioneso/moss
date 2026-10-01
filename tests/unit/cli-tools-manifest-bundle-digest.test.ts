import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertBundleDigest,
  bundleDigest
} from "../../scripts/cli-tools-manifest/bundle-digest.js";

const dirs: string[] = [];
async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cli-tools-digest-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("bundle digest", () => {
  it("accepts an untouched bundle", async () => {
    const dir = await bundle({ "a.json": "1", "sub/b.json": "2" });
    await expect(assertBundleDigest(dir, await bundleDigest(dir))).resolves.toBeUndefined();
  });

  it("refuses a changed file, an added file and a removed file", async () => {
    const dir = await bundle({ "a.json": "1", "b.json": "2" });
    const digest = await bundleDigest(dir);
    await writeFile(path.join(dir, "a.json"), "evil");
    await expect(assertBundleDigest(dir, digest)).rejects.toThrow(/changed after the prepare job/);
    await writeFile(path.join(dir, "a.json"), "1");
    await writeFile(path.join(dir, "c.json"), "3");
    await expect(assertBundleDigest(dir, digest)).rejects.toThrow(/changed after/);
    await rm(path.join(dir, "c.json"));
    await rm(path.join(dir, "b.json"));
    await expect(assertBundleDigest(dir, digest)).rejects.toThrow(/changed after/);
  });

  it("refuses to sign when no digest was supplied", async () => {
    const dir = await bundle({ "a.json": "1" });
    await expect(assertBundleDigest(dir, undefined)).rejects.toThrow(/no prepare-job digest/);
    await expect(assertBundleDigest(dir, "nothex")).rejects.toThrow(/no prepare-job digest/);
  });

  // Runs the real sign entry point. It must stop on the digest before it looks for any key.
  it("makes the sign command refuse a tampered bundle", async () => {
    const dir = await bundle({ "prepare-result.json": '{"outcomes":[],"attested":[]}' });
    const digest = await bundleDigest(dir);
    await writeFile(path.join(dir, "prepare-result.json"), '{"outcomes":[],"attested":[1]}');
    const run = promisify(execFile)(
      "npx",
      ["tsx", "scripts/cli-tools-manifest/cli.ts", "sign", "--in", dir, "--previous-dir", dir],
      { env: { ...process.env, EXPECTED_BUNDLE_DIGEST: digest } }
    );
    await expect(run).rejects.toMatchObject({
      stderr: expect.stringContaining("changed after the prepare job")
    });
  });
});
