/**
 * Where a provider's own transcripts live, and how to purge them, outside the
 * scratch working folder AcpHost already owns. Split out of acp-host.ts so
 * that file stays under the file-size gate (task 5b, 2026-09-08 precedent).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { buildSetprivDropCommand } from "./setpriv.js";
import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { type AcpProviderKind } from "@moss/acp";
import { transcriptGlobDir } from "@moss/ai";

/**
 * A provider's own transcript store outside the scratch folder, or null if
 * none is known. Only providers whose transcript folder is already keyed by
 * this session's own working folder belong here — Codex is not: its sessions
 * root is shared by every one of the account's chats and dated by wall-clock
 * time, not by session, so it is purged separately by `purgeCodexTranscripts`.
 */
export function acpProviderTranscriptDir(
  provider: AcpProviderKind,
  cwd: string,
  home: string
): string | null {
  switch (provider) {
    case "anthropic":
      return transcriptGlobDir("anthropic", cwd, home);
    default:
      return null;
  }
}

/** Codex's shared sessions root for one account, under its own home. */
function codexSessionsRoot(home: string): string {
  return join(home, ".codex", "sessions");
}

/**
 * Delete only this session's own Codex transcript files as the owning
 * account, matched by the working folder recorded in each file's own first
 * line (see codex-transcript-purge.mjs for why: Codex shares one dated
 * sessions root across every chat, and the runner never learns Codex's own
 * conversation id to narrow the search any other way).
 */
export async function defaultPurgeCodexTranscripts(
  home: string,
  cwd: string,
  identity: { readonly uid: number; readonly gid: number } | null
): Promise<void> {
  const script = createRequire(import.meta.url).resolve("./codex-transcript-purge.mjs");
  const request = JSON.stringify({ root: codexSessionsRoot(home), cwd });
  const spawnArgs = identity
    ? buildSetprivDropCommand(process.execPath, [script, request], identity)
    : { command: process.execPath, args: [script, request] };
  await new Promise<void>((resolve, reject) => {
    const purger = spawn(spawnArgs.command, spawnArgs.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: buildSanitizedCliEnv(process.env)
    });
    let stderr = "";
    purger.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    purger.once("error", reject);
    purger.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Codex transcript purge for ${cwd} exited with code ${String(code)}: ${stderr.trim()}`
          )
        );
    });
  });
}
