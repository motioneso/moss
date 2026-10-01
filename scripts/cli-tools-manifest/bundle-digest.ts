// A fingerprint of the prepared bundle. The prepare job publishes it as a job output, which no
// later job can change, and the sign job refuses to sign a bundle that does not match.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(path.join(root, rel))).sort()) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    const info = await lstat(path.join(root, relPath));
    if (info.isDirectory()) out.push(...(await listFiles(root, relPath)));
    else if (info.isFile()) out.push(relPath);
    else throw new Error(`${relPath} is not a regular file`);
  }
  return out;
}

/** Hash of every file name and content under `dir`. Order independent of the filesystem. */
export async function bundleDigest(dir: string): Promise<string> {
  const total = createHash("sha256");
  for (const rel of await listFiles(dir)) {
    const fileHash = createHash("sha256")
      .update(await readFile(path.join(dir, rel)))
      .digest("hex");
    total.update(`${rel}\0${fileHash}\n`);
  }
  return total.digest("hex");
}

export async function assertBundleDigest(dir: string, expected: string | undefined): Promise<void> {
  if (expected === undefined || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("no prepare-job digest was supplied; refusing to sign");
  }
  if ((await bundleDigest(dir)) !== expected) {
    throw new Error("the prepared bundle changed after the prepare job; refusing to sign");
  }
}
