import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export type CodexAuthFileReader = (path: string) => Promise<string>;

const defaultReadCodexAuthFile: CodexAuthFileReader = (path) => readFile(path, "utf8");

/** The Codex login source owned by the user whose slot is about to run. */
export function codexAuthPath(homeBase: string, userId: string): string {
  return join(homeBase, "agents", userId, ".codex", "auth.json");
}

async function assertRealPath(path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("missing Codex login", { cause: error });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("symlinked Codex login");
  }
}

async function readRealFile(path: string): Promise<string> {
  await assertRealPath(path);
  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Read and validate the selected user's Codex login without returning parsed secrets. */
export async function readCodexAuthFile(
  homeBase: string,
  userId: string,
  read: CodexAuthFileReader = defaultReadCodexAuthFile
): Promise<string> {
  try {
    const path = codexAuthPath(homeBase, userId);
    const raw = read === defaultReadCodexAuthFile ? await readRealFile(path) : await read(path);
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    if (
      typeof parsed.tokens?.access_token !== "string" ||
      parsed.tokens.access_token.length === 0 ||
      typeof parsed.tokens.account_id !== "string" ||
      parsed.tokens.account_id.length === 0
    ) {
      throw new Error("missing Codex login");
    }
    return raw;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "symlinked Codex login" || message.includes("permission")) throw error;
    throw new Error("Not logged in (no Codex credential in runner home)", { cause: error });
  }
}
