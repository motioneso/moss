import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, renameSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderLoginScope } from "@moss/shared";

import { providerTokenPath } from "./provider-token-store.js";

/** A separate namespace: no ordinary login or readiness probe can create this file. */
export function scopedClaudeTokenPath(homeBase: string, scope: ProviderLoginScope): string {
  if (
    ![scope.actorUserId, scope.providerConfigId].every(
      (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id)
    )
  ) {
    throw new Error("Invalid credential scope");
  }
  const key = createHash("sha256")
    .update(JSON.stringify([scope.actorUserId, scope.providerConfigId]))
    .digest("hex");
  return path.join(homeBase, ".jarvis", "scoped-cli-tokens", key, "anthropic");
}

/** Explicit environment used by both fresh setup-token and its authenticated validation call. */
export function freshClaudeEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, "config"),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
}

/** No cache, ambient credentials, tools, hooks or persisted sessions; output never escapes. */
export async function validateFreshClaudeToken(
  executable: string,
  home: string,
  token: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    const child = spawn(
      executable,
      [
        "--print",
        "Reply with exactly OK.",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true,"autoMemoryEnabled":false}',
        "--no-session-persistence"
      ],
      {
        cwd: home,
        env: { ...freshClaudeEnv(home), CLAUDE_CODE_OAUTH_TOKEN: token },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    return await new Promise<boolean>((resolve) => {
      let failed = false;
      let bytes = 0;
      const output: Buffer[] = [];
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const fail = () => {
        failed = true;
        killGroup();
      };
      const timer = setTimeout(fail, 25_000);
      signal.addEventListener("abort", fail, { once: true });
      if (signal.aborted) fail();
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) fail();
          else if (stream === child.stdout) output.push(chunk);
        });
      }
      child.once("error", fail);
      // Even a successful parent can leave descendants holding pipes or the credential env.
      child.once("exit", killGroup);
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        resolve(
          !failed &&
            !signal.aborted &&
            code === 0 &&
            /^\s*OK[.!]?\s*$/i.test(Buffer.concat(output).toString("utf8"))
        );
      });
    });
  } catch {
    return false;
  }
}

/** Publish only a validated, still-current flow. No await can race cancellation with publication. */
export async function publishFreshClaudeToken(
  homeBase: string,
  scope: ProviderLoginScope,
  token: string,
  isCurrent: () => boolean,
  onPublished: () => void
): Promise<void> {
  await publishFreshCredentialFiles(
    [
      [providerTokenPath(homeBase, "anthropic"), token],
      [scopedClaudeTokenPath(homeBase, scope), token]
    ],
    isCurrent,
    onPublished
  );
}

/** Ordinary native files precede the scoped terminal commit; failed renames restore prior state.
 * ponytail: process-local rollback, not a crash-atomic transaction across native credential files.
 */
export async function publishFreshCredentialFiles(
  records: readonly (readonly [string, string])[],
  isCurrent: () => boolean,
  onPublished: () => void
): Promise<void> {
  const suffix = `.${randomUUID()}.tmp`;
  const changed: { file: string; backup: string; hadPrevious: boolean }[] = [];
  try {
    for (const [file, content] of records) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file + suffix, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    if (!isCurrent()) throw new Error("Login is no longer active");
    // No await between current-flow check, publication, rollback and terminal commit.
    try {
      for (const [file] of records) {
        const backup = file + suffix + ".previous";
        let hadPrevious = false;
        try {
          linkSync(file, backup);
          hadPrevious = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          renameSync(file + suffix, file);
        } catch (error) {
          if (hadPrevious) rmSync(backup);
          throw error;
        }
        changed.push({ file, backup, hadPrevious });
      }
    } catch (error) {
      let restoreError: unknown;
      for (const { file, backup, hadPrevious } of changed.reverse()) {
        try {
          if (hadPrevious) renameSync(backup, file);
          else rmSync(file, { force: true });
        } catch (failure) {
          restoreError ??= failure; // Retain the backup and attempt every remaining restore.
        }
      }
      throw restoreError ?? error;
    }
    onPublished();
    for (const { backup, hadPrevious } of changed) {
      if (hadPrevious) {
        try {
          rmSync(backup);
        } catch {
          /* Retain recovery data if cleanup is unavailable. */
        }
      }
    }
  } finally {
    await Promise.all(
      records.map(([file]) => rm(file + suffix, { force: true }).catch(() => undefined))
    );
  }
}
