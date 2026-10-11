import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function runClaudeNativeHook(
  source: string,
  event: unknown,
  options: { baseUrl: string; root: string; token?: string }
) {
  const dir = await mkdtemp(join(tmpdir(), "moss-native-hook-"));
  const script = join(dir, "hook.mjs");
  const tokenFile = join(dir, "token");
  await writeFile(script, source);
  if (options.token !== undefined) await writeFile(tokenFile, options.token);
  try {
    const child = spawn(process.execPath, [script], {
      env: {
        JARVIS_NOTES_ROOTS: options.root,
        JARVIS_SESSION_ROOT: options.root,
        JARVIS_VAULT_READ_REPORT_URL: `${options.baseUrl}/internal/vault-read-report`,
        JARVIS_PERM_URL: `${options.baseUrl}/internal/permission`,
        JARVIS_PERM_TOKEN_FILE: tokenFile
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end(JSON.stringify(event));
    const code = await exited;
    const output = JSON.parse(stdout) as {
      hookSpecificOutput: {
        permissionDecision: "allow" | "deny";
        permissionDecisionReason: string;
      };
    };
    return { code, stdout, stderr, ...output.hookSpecificOutput };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
