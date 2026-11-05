import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";

import { ConstrainedProcessError } from "./constrained-structured-process.js";
import { CliChatUnavailableError } from "./errors.js";

const unsupported = () => new CliChatUnavailableError("Constrained runtime is unsupported");

async function executableDigest(path: string, signal?: AbortSignal): Promise<string> {
  const stream = createReadStream(path, { signal });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
      if (bytes > 400 * 1024 * 1024) throw unsupported();
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

/** Bounded per-process cache; replacement and same-size/mtime edits invalidate by inode/ctime. */
export function createExecutableDigestCache(
  readDigest: (path: string, signal?: AbortSignal) => Promise<string> = executableDigest,
  capacity = 8
): (path: string, signal?: AbortSignal) => Promise<string> {
  const cache = new Map<string, { fingerprint: string; digest: string }>();
  const fingerprint = async (path: string) => {
    const value = await stat(path, { bigint: true });
    if (!value.isFile() || value.size > 400n * 1024n * 1024n) throw unsupported();
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode].join(":");
  };
  return async (path, signal) => {
    if (signal?.aborted) throw new ConstrainedProcessError("cancelled");
    const resolved = await realpath(path);
    const before = await fingerprint(resolved);
    const saved = cache.get(resolved);
    if (saved?.fingerprint === before) {
      cache.delete(resolved);
      cache.set(resolved, saved);
      return saved.digest;
    }
    cache.delete(resolved);
    const digest = await readDigest(resolved, signal);
    if (signal?.aborted) throw new ConstrainedProcessError("cancelled");
    if ((await fingerprint(resolved)) !== before) throw unsupported();
    cache.set(resolved, { fingerprint: before, digest });
    while (cache.size > Math.max(1, capacity)) cache.delete(cache.keys().next().value!);
    return digest;
  };
}
