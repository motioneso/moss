/**
 * The home-preparation helper, run as the person's own slot. It creates folders and writes secret
 * files inside a home the runner has already handed over and can no longer enter.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { buildSetprivDropCommand } from "./setpriv.js";

/** Argument passed as one JSON string to agent-home-prepare.mjs. */
export interface AgentHomePrepareRequest {
  readonly dirs: readonly string[];
  readonly denyFile: { readonly path: string; readonly permissionKeys: readonly string[] } | null;
}

export interface AgentHomeSecretFile {
  readonly path: string;
  readonly sourcePath?: string;
  readonly content?: string;
  readonly kind?: "codex-auth";
}

export type AgentHomePrepareRun = (
  request: AgentHomePrepareRequest,
  identity: { uid: number; gid: number },
  secretFiles?: readonly AgentHomeSecretFile[]
) => Promise<void>;

/**
 * Run the below-top-level preparation step as the person's own slot: setpriv
 * switches identity, then the runner's own Node binary runs the script,
 * given the request as one JSON argv element (never through a shell, so
 * nothing in it is ever interpolated). Secret files travel by stdin. A non-zero exit fails the launch with
 * the step's own stderr (task 5b, Architect ruling, 2026-09-08).
 */
export async function runAgentHomePrepareAsOwner(
  request: AgentHomePrepareRequest,
  identity: { uid: number; gid: number },
  secretFiles: readonly AgentHomeSecretFile[] = []
): Promise<void> {
  const script = createRequire(import.meta.url).resolve("./agent-home-prepare.mjs");
  const { command, args } = buildSetprivDropCommand(
    process.execPath,
    [script, JSON.stringify(request)],
    identity
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: buildSanitizedCliEnv(process.env)
    });
    child.stdin.end(JSON.stringify(secretFiles));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `AcpHost: could not prepare the agent's home: ${stderr.trim() || `exit code ${String(code)}`}`
          )
        );
    });
  });
}
