import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The common provisioner copies host Codex auth when its configured file exists.
 * Draft-only Meetings UAT does not need it: use the supported override pointing to
 * an absent file in a fresh private directory, without reading the host login.
 */
export async function withMeetingUatEnvironment(
  run: (env: NodeJS.ProcessEnv) => Promise<number>,
  baseEnvironment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "moss-meetings-uat-"));
  try {
    return await run({
      ...baseEnvironment,
      JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: join(directory, "not-configured.json")
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  process.exitCode = await withMeetingUatEnvironment(
    (env) =>
      new Promise<number>((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "tests/uat/run-uat.ts", "2981-meeting-drafts.uat.spec.ts"],
          { env, stdio: "inherit" }
        );
        child.on("error", reject);
        child.on("exit", (code) => resolveExit(code ?? 1));
      })
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
