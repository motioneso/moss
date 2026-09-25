/**
 * The instance's shared Codex login (#2687).
 *
 * An administrator connects Codex once. The resulting login file lives in the runner's own auth
 * home, 0600 and owned by the runner, beside Claude's saved token. Every user's Codex runs in their
 * own home as their own account, with a copy of that file seeded before each launch or check.
 *
 * Codex rewrites its login file when it refreshes its tokens, and the refresh retires the old
 * refresh token. So a user's copy that Codex refreshed more recently, for the same account,
 * becomes the shared login; every other copy is replaced by the shared login. A different account
 * never replaces the shared login this way. Only a completed administrator sign-in does that.
 */
import { randomUUID } from "node:crypto";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { TmuxIo } from "@moss/ai";

import { createCodexAuthFileReader } from "./acp-codex-auth.js";
import type { AgentHomePrepareRun } from "./agent-home-prepare-run.js";
import { Mutex } from "./mutex.js";

/** Read and write one user's Codex login file, as that user. */
export interface CodexHomeAccess {
  /** The user's login file, or null when they have none. */
  read(): Promise<string | null>;
  /** Replace the user's login file, 0600. */
  write(raw: string): Promise<void>;
}

export type CodexLoginPlan =
  | { readonly action: "seed"; readonly raw: string }
  | { readonly action: "promote"; readonly raw: string }
  | { readonly action: "keep" }
  | { readonly action: "none" };

export type CodexLoginSyncResult = "seeded" | "promoted" | "kept" | "none";

interface ParsedCodexLogin {
  readonly raw: string;
  readonly accountId: string;
  readonly refreshedAt: number;
}

const locks = new Map<string, Mutex>();

/** The shared Codex login file in the runner's auth home. */
export function instanceCodexAuthPath(homeBase: string): string {
  return join(homeBase, ".codex", "auth.json");
}

function parseCodexLogin(raw: string | null): ParsedCodexLogin | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as {
    tokens?: { access_token?: unknown; account_id?: unknown };
    last_refresh?: unknown;
  };
  const accessToken = record.tokens?.access_token;
  const accountId = record.tokens?.account_id;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof accountId !== "string" || accountId.length === 0) return null;
  const refreshedAt =
    typeof record.last_refresh === "string" ? Date.parse(record.last_refresh) : Number.NaN;
  return {
    raw,
    accountId,
    refreshedAt: Number.isNaN(refreshedAt) ? Number.NEGATIVE_INFINITY : refreshedAt
  };
}

/** Decide what one user's copy needs, given the shared login. Unusable files count as absent. */
export function planCodexLoginSync(
  instanceRaw: string | null,
  userRaw: string | null
): CodexLoginPlan {
  const instance = parseCodexLogin(instanceRaw);
  const user = parseCodexLogin(userRaw);
  if (!instance) return user ? { action: "keep" } : { action: "none" };
  if (user && user.raw === instance.raw) return { action: "keep" };
  if (user && user.accountId === instance.accountId && user.refreshedAt > instance.refreshedAt) {
    return { action: "promote", raw: user.raw };
  }
  return { action: "seed", raw: instance.raw };
}

async function readInstance(homeBase: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(instanceCodexAuthPath(homeBase), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("could not read the shared Codex login", { cause: error });
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error("shared Codex login is not a file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeInstance(homeBase: string, raw: string): Promise<void> {
  const dir = join(homeBase, ".codex");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.auth.json.${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, instanceCodexAuthPath(homeBase));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withLock<T>(homeBase: string, fn: () => Promise<T>): Promise<T> {
  let lock = locks.get(homeBase);
  if (!lock) {
    lock = new Mutex();
    locks.set(homeBase, lock);
  }
  const release = await lock.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Bring one user's Codex login in line with the shared login before Codex runs in their home.
 * Seeds the shared login, carries a newer refresh back to it, or leaves the user's copy alone.
 */
export async function syncCodexLoginIntoHome(
  homeBase: string,
  home: CodexHomeAccess
): Promise<CodexLoginSyncResult> {
  return withLock(homeBase, async () => {
    const plan = planCodexLoginSync(await readInstance(homeBase), await home.read());
    switch (plan.action) {
      case "seed":
        await home.write(plan.raw);
        return "seeded";
      case "promote":
        await writeInstance(homeBase, plan.raw);
        return "promoted";
      case "keep":
        return "kept";
      case "none":
        return "none";
    }
  });
}

/** Make a completed administrator sign-in the shared login, whatever its account. */
export async function promoteCodexLogin(homeBase: string, raw: string): Promise<void> {
  if (!parseCodexLogin(raw)) throw new Error("the Codex sign-in left no usable login file");
  await withLock(homeBase, () => writeInstance(homeBase, raw));
}

/**
 * Access to a user's Codex login through their own account. The runner cannot enter a home it has
 * handed over, so reads run as the user and writes go through the home-preparation helper. The
 * login travels by stdin and stdout, never by argv or env.
 */
export function ownerCodexHomeAccess(
  agentHome: string,
  identity: { readonly uid: number; readonly gid: number },
  runAsOwner: Pick<TmuxIo, "run">,
  runPrepare: AgentHomePrepareRun
): CodexHomeAccess {
  const path = join(agentHome, ".codex", "auth.json");
  const read = createCodexAuthFileReader({ homeBase: agentHome, userId: "", io: runAsOwner });
  return {
    read: async () => {
      try {
        return await read(path);
      } catch (error) {
        if (error instanceof Error && error.message === "missing Codex login") return null;
        throw error;
      }
    },
    write: (raw) =>
      runPrepare({ dirs: [join(agentHome, ".codex")], denyFile: null }, identity, [
        { path, content: raw, kind: "codex-auth" }
      ])
  };
}
