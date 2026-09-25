/**
 * The instance's shared Codex login (#2687).
 *
 * An administrator connects Codex once. The resulting login file lives in the runner's own auth
 * home, 0600 and owned by the runner, beside Claude's saved token. Every user's Codex runs in their
 * own home as their own account, with a copy of that file seeded before each launch or check.
 *
 * Codex rewrites its login file when it refreshes its tokens, and the refresh retires the old
 * refresh token. So before any user's Codex runs, the runner looks at every user's copy and makes
 * the most recently issued one for the shared account the shared login. Identity and issue time
 * come from the access token's own claims, never from the file's editable fields, so a copy
 * holding another account's tokens is never promoted. Only a completed administrator sign-in
 * changes the shared account.
 */
import { randomUUID } from "node:crypto";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { TmuxIo } from "@moss/ai";

import { createCodexAuthFileReader } from "./acp-codex-auth.js";
import type { AgentHomePrepareRun } from "./agent-home-prepare-run.js";
import { Mutex } from "./mutex.js";
import { listUserUidSlots } from "./uid-allocator.js";

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
  /** The account named by the access token's claims, or null when they cannot vouch for it. */
  readonly accountId: string | null;
  /** When the access token was issued, in seconds. */
  readonly issuedAt: number;
}

const locks = new Map<string, Mutex>();

/** The shared Codex login file in the runner's auth home. */
export function instanceCodexAuthPath(homeBase: string): string {
  return join(homeBase, ".codex", "auth.json");
}

const AUTH_CLAIMS = "https://api.openai.com/auth";

function tokenClaims(token: string): { accountId?: unknown; issuedAt?: unknown } | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      iat?: unknown;
      [AUTH_CLAIMS]?: { chatgpt_account_id?: unknown };
    };
    return { accountId: claims[AUTH_CLAIMS]?.chatgpt_account_id, issuedAt: claims.iat };
  } catch {
    return null;
  }
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
  const tokens = (parsed as { tokens?: { access_token?: unknown; account_id?: unknown } }).tokens;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof tokens?.account_id !== "string" || tokens.account_id.length === 0) return null;
  const claims = tokenClaims(accessToken);
  const identified =
    claims !== null &&
    claims.accountId === tokens.account_id &&
    typeof claims.issuedAt === "number" &&
    Number.isFinite(claims.issuedAt);
  return {
    raw,
    accountId: identified ? tokens.account_id : null,
    issuedAt: identified ? (claims.issuedAt as number) : Number.NEGATIVE_INFINITY
  };
}

/** True when `candidate` is the same account as `current`, issued strictly later. */
function supersedes(candidate: ParsedCodexLogin | null, current: ParsedCodexLogin): boolean {
  return (
    candidate !== null &&
    candidate.accountId !== null &&
    candidate.accountId === current.accountId &&
    candidate.issuedAt > current.issuedAt
  );
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
  if (user && supersedes(user, instance)) return { action: "promote", raw: user.raw };
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

/** Promote the newest same-account copy among `candidates`. Returns the shared login after. */
async function publishNewest(
  homeBase: string,
  instanceRaw: string | null,
  candidates: readonly (string | null)[]
): Promise<string | null> {
  const instance = parseCodexLogin(instanceRaw);
  if (!instance) return instanceRaw;
  let newest = instance;
  for (const raw of candidates) {
    const candidate = parseCodexLogin(raw);
    if (supersedes(candidate, newest)) newest = candidate as ParsedCodexLogin;
  }
  if (newest === instance) return instanceRaw;
  await writeInstance(homeBase, newest.raw);
  return newest.raw;
}

/** Read other users' copies. One unreadable home never blocks another user's launch. */
function readPeers(peers: readonly CodexHomeAccess[]): Promise<(string | null)[]> {
  return Promise.all(peers.map((peer) => peer.read().catch(() => null)));
}

/**
 * Bring one user's Codex login in line with the shared login before Codex runs in their home.
 * A newer refresh held in this home or any `peers` home is carried back to the shared login
 * first, so this user never starts from a refresh token another user's Codex already retired.
 */
export async function syncCodexLoginIntoHome(
  homeBase: string,
  home: CodexHomeAccess,
  peers: readonly CodexHomeAccess[] = []
): Promise<CodexLoginSyncResult> {
  return withLock(homeBase, async () => {
    const [instanceRaw, userRaw, peerRaws] = await Promise.all([
      readInstance(homeBase),
      home.read(),
      readPeers(peers)
    ]);
    const sharedRaw = await publishNewest(homeBase, instanceRaw, peerRaws);
    const plan = planCodexLoginSync(sharedRaw, userRaw);
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

/** Carry the newest refresh held in any of `homes` back to the shared login. */
export async function publishNewestCodexLogin(
  homeBase: string,
  homes: readonly CodexHomeAccess[]
): Promise<boolean> {
  return withLock(homeBase, async () => {
    const instanceRaw = await readInstance(homeBase);
    return (await publishNewest(homeBase, instanceRaw, await readPeers(homes))) !== instanceRaw;
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

/** Every other user's Codex home that holds a slot, each read through its own account. */
export function codexPeerHomes(
  homeBase: string,
  exceptUserId: string | undefined,
  access: (agentHome: string, identity: { uid: number; gid: number }) => CodexHomeAccess
): CodexHomeAccess[] {
  return listUserUidSlots(homeBase)
    .filter((slot) => slot.userId !== exceptUserId)
    .map((slot) => access(join(homeBase, "agents", slot.userId), slot));
}
