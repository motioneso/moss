import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

/** #2689: the version of the image's OpenCode package, or `null` when it cannot be read. */
export async function readOpenCodeVersion(): Promise<string | null> {
  try {
    const packageJson = createRequire(import.meta.url).resolve("opencode-ai/package.json");
    const { version } = JSON.parse(await readFile(packageJson, "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
