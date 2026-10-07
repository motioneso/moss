import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppActionsUatMode = "scripted" | "real";

export function appActionsUatSpec(mode: string = "scripted"): string {
  if (mode === "scripted") return "3065-app-actions.uat.spec.ts";
  if (mode === "real") return "3065-app-actions-real.uat.spec.ts";
  throw new Error("Unknown app-actions UAT mode");
}

/** Refuse an accidental real run before the common provisioner can inspect/copy a login. */
export async function withAppActionsUatEnvironment(
  mode: AppActionsUatMode,
  run: (env: NodeJS.ProcessEnv) => Promise<number>,
  base: NodeJS.ProcessEnv = process.env
): Promise<number> {
  appActionsUatSpec(mode);
  if (mode === "real") {
    if (base.JARVIS_UAT_REAL_CHAT_CONFIGURED !== "1")
      throw new Error(
        "Real app-actions proof was not run. The owner must explicitly set " +
          "JARVIS_UAT_REAL_CHAT_CONFIGURED=1 after reviewing the live-proof checklist. " +
          "The existing UAT provisioner copies the owner's Codex login into its disposable stack."
      );
    return run({ ...base, MOSS_UAT_CAPTURE_OFF: "1", MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF: "1" });
  }
  // The supported override points to a known-absent file in this run's own private directory.
  // No host credential path is read, even when this command is run on a signed-in machine.
  const directory = await mkdtemp(join(tmpdir(), "moss-app-actions-uat-"));
  try {
    return await run({
      ...base,
      JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: join(directory, "not-configured.json"),
      JARVIS_UAT_REAL_CHAT_CONFIGURED: "",
      MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF: "",
      MOSS_UAT_CAPTURE_OFF: "1"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // Mode is an explicit command argument, never a stale inherited environment setting.
  const mode = process.argv[2] ?? "scripted";
  const spec = appActionsUatSpec(mode);
  console.log(`[app-actions-uat] mode=${mode}; spec=${spec}; captures=off`);
  process.exitCode = await withAppActionsUatEnvironment(
    mode as AppActionsUatMode,
    (env) =>
      new Promise<number>((done, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "tests/uat/run-uat.ts", spec], {
          env,
          stdio: "inherit"
        });
        child.on("error", reject);
        child.on("exit", (code) => done(code ?? 1));
      })
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
