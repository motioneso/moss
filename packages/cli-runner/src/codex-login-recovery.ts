/** Runner-owned, auth-only recovery when a temporary home's login cannot reach its owner. */
import { randomUUID } from "node:crypto";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

function recoveryDir(homeBase: string): string {
  return join(homeBase, ".codex", "refresh-recovery");
}

/** Call under the shared-login lock. Retaining a candidate does not establish trust in it. */
export async function retainCodexLogin(homeBase: string, raw: string): Promise<void> {
  const dir = recoveryDir(homeBase);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.json`);
  const tmp = `${path}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(raw, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface RetainedCodexLogin {
  readonly raw: string;
  remove(): Promise<void>;
}

/** Only finalized runner-owned files are candidates; temporary writes are never consumed. */
export async function readRetainedCodexLogins(homeBase: string): Promise<RetainedCodexLogin[]> {
  const dir = recoveryDir(homeBase);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries: RetainedCodexLogin[] = [];
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(dir, name);
    const handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid Codex recovery file");
      entries.push({ raw: await handle.readFile("utf8"), remove: () => rm(path, { force: true }) });
    } finally {
      await handle.close();
    }
  }
  return entries;
}
