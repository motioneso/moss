import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MEETING_UAT_GROUPS = {
  meetings: [
    "2981-meeting-drafts.uat.spec.ts",
    "2981-meeting-chat.uat.spec.ts",
    "2981-meeting-outputs.uat.spec.ts",
    "2981-meeting-history.uat.spec.ts",
    "2981-meeting-capture.uat.spec.ts",
    "2981-meeting-automatic-summary.uat.spec.ts"
  ],
  chat: [
    "1089-1090-chat-drawer-private.uat.spec.ts",
    "3274-meeting-new-side-chat.uat.spec.ts",
    "1133-chat-attachments.uat.spec.ts",
    "runtime-context.uat.spec.ts",
    "moss-assistant-name.uat.spec.ts"
  ],
  runtime: [
    "module-install.uat.spec.ts",
    "1217-uat-vault-ownership.uat.spec.ts",
    "1311-install-grant.uat.spec.ts",
    "1112-today-masthead-oneline.uat.spec.ts"
  ],
  "model-fixtures": [
    "2956-activity-history.uat.spec.ts",
    "2911-shadow-delete.uat.spec.ts",
    "2911-shadow-purge-queue.uat.spec.ts",
    "classifier-shadow.uat.spec.ts",
    "shadow-report.uat.spec.ts"
  ]
} as const;

/** A closed group enum, never caller-supplied spec paths or an all-spec fallback. */
export function meetingUatSpecs(group = "meetings"): readonly string[] {
  if (!Object.hasOwn(MEETING_UAT_GROUPS, group))
    throw new Error("Unknown credential-free Meetings UAT group");
  return MEETING_UAT_GROUPS[group as keyof typeof MEETING_UAT_GROUPS];
}

/**
 * The common provisioner copies host Codex auth when its configured file exists.
 * Meetings UAT uses only an isolated HTTP stand-in and does not need it: use the supported override pointing to
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
      JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: join(directory, "not-configured.json"),
      // A stale inherited readiness flag must not imply that real credentials were installed.
      JARVIS_UAT_REAL_CHAT_CONFIGURED: "",
      MOSS_UAT_CAPTURE_OFF: "1"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const group = process.env.MOSS_MEETING_UAT_GROUP ?? "meetings";
  const specs = meetingUatSpecs(group);
  console.log(`[meetings-uat] credential-free group=${group}; specs=${specs.length}; captures=off`);
  console.log(
    "[meetings-uat] fixed skips are not passing proof: attachments(1), install-grant(1), runtime-context(2). Real-provider sports/notes/Workshop gates are not run by this wrapper."
  );
  process.exitCode = await withMeetingUatEnvironment(
    (env) =>
      new Promise<number>((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "tests/uat/run-uat.ts", ...specs],
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
