import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CodexAuthFileReader = (path: string) => Promise<string>;

/** Read and validate the runner-owned Codex login without returning parsed secrets. */
export async function readCodexAuthFile(
  homeBase: string,
  read: CodexAuthFileReader = (path) => readFile(path, "utf8")
): Promise<string> {
  try {
    const raw = await read(join(homeBase, ".codex", "auth.json"));
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
  } catch {
    throw new Error("Not logged in (no Codex credential in runner home)");
  }
}
