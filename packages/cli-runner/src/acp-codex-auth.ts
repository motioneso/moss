import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "node:constants";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TmuxIo } from "@moss/ai";

export type CodexAuthFileReader = (path: string) => Promise<string>;

const CODEX_LOGIN_REQUIRED = "Not logged in (no usable Codex credential in your runner home)";

const OWNER_READ_SCRIPT = `
const fs = require("node:fs");
const path = process.argv[1];
try {
  const parts = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? "/" + part : current ? current + "/" + part : part;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink");
  }
  const sourceStat = fs.lstatSync(path);
  if (!sourceStat.isFile()) throw new Error("regular file");
  // O_NONBLOCK prevents a planted FIFO from hanging the owner process before
  // the descriptor's regular-file check runs.
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("regular file");
    process.stdout.write(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
} catch (error) {
  process.exitCode = error && typeof error === "object" && error.code === "ENOENT" ? 2 : 1;
}
`;

/** Build the only reader allowed to supply an isolated Codex verification credential. */
export function createCodexAuthFileReader(runtime: {
  readonly homeBase: string;
  readonly userId: string;
  readonly io: Pick<TmuxIo, "run">;
}): CodexAuthFileReader {
  const expectedPath = join(runtime.homeBase, ".codex", "auth.json");
  return async (path: string): Promise<string> => {
    if (path !== expectedPath) throw new Error("Codex credential path is outside the runtime home");
    const result = await runtime.io.run(process.execPath, ["-e", OWNER_READ_SCRIPT, expectedPath]);
    if (result.code === 2) throw new Error("missing Codex login");
    if (result.code !== 0) throw new Error("Codex credential could not be read by its owner");
    return result.stdout;
  };
}

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
  const handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("non-regular Codex login");
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
    let parsed: { tokens?: { access_token?: unknown; account_id?: unknown } };
    try {
      parsed = JSON.parse(raw) as {
        tokens?: { access_token?: unknown; account_id?: unknown };
      };
    } catch {
      throw new Error(CODEX_LOGIN_REQUIRED);
    }
    if (
      typeof parsed.tokens?.access_token !== "string" ||
      parsed.tokens.access_token.length === 0 ||
      typeof parsed.tokens.account_id !== "string" ||
      parsed.tokens.account_id.length === 0
    ) {
      throw new Error(CODEX_LOGIN_REQUIRED);
    }
    return raw;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === CODEX_LOGIN_REQUIRED) throw error;
    if (message === "missing Codex login" || (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(CODEX_LOGIN_REQUIRED, {
        cause: error
      });
    }
    throw error;
  }
}
