import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGeminiSourceCredential } from "@moss/chat/live";
import type { ProviderLoginScope } from "@moss/shared";
import { scopedClaudeTokenPath } from "./fresh-cli-login.js";

export function scopedGeminiCredentialPath(homeBase: string, scope: ProviderLoginScope): string {
  // Reuse the validated actor/config namespace; ordinary native OAuth state cannot populate it.
  return path.join(path.dirname(scopedClaudeTokenPath(homeBase, scope)), "google");
}

/** The single runner process is the only writer. These callbacks must be synchronous/nonthrowing. */
export async function publishGeminiCredential(
  homeBase: string,
  scope: ProviderLoginScope,
  input: unknown,
  guard: ({ kind: "login" } | { kind: "refresh"; expectedVersion: string }) & {
    isCurrent: () => boolean;
    onPublished: () => void;
  }
): Promise<boolean> {
  const record = JSON.stringify(parseGeminiSourceCredential(input));
  const target = scopedGeminiCredentialPath(homeBase, scope);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temporary, record, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (!guard.isCurrent()) return false;
    // No await between version/current-flow checks, rename and terminal commit. A cancelled
    // source or one holding an older login's snapshot cannot replace the current credential.
    if (guard.kind === "refresh") {
      try {
        const info = lstatSync(target);
        if (!info.isFile() || info.size > 65_536) return false;
        const current = readFileSync(target);
        const version = createHash("sha256").update(current).digest("hex");
        if (version !== guard.expectedVersion) return false;
      } catch {
        return false;
      }
    }
    renameSync(temporary, target);
    guard.onPublished();
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}
