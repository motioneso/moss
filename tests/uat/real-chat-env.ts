// tests/uat/real-chat-env.ts
//
// #1121 real-chat token handling, split out of provisioner.ts (#1659: the file crossed the
// 1000-line check:file-size cap). This is credential-decryption code and the only part of UAT
// provisioning that touches secret material — a separate file, not a bigger one.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { UatEnvFile } from "./provisioner.js";

const execFileAsync = promisify(execFile);

// #1121: operator-provided path to a GPG-encrypted file holding the real chat token; absent by
// default so this whole path is inert for CI/default runs (Coordinator constraint: "Default CI
// remains credential-free and unchanged").
const REAL_CHAT_TOKEN_TRIGGER_ENV = "JARVIS_UAT_REAL_CHAT_TOKEN_FILE";
const REAL_CHAT_TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
// #1121: same var docker-compose.prod.yml's `seed` service reads as its opt-in second env_file
// entry (infra/docker-compose.prod.yml) — must be exported for compose interpolation, exactly
// like uatComposeInterpolationEnv's vars in provisioner.ts.
export const REAL_CHAT_ENV_FILE_RESULT_ENV = "JARVIS_UAT_REAL_CHAT_ENV_FILE";

/**
 * #1121 (Coordinator constraint 1): fail closed — the decrypted plaintext must contain EXACTLY
 * one nonempty key, CLAUDE_CODE_OAUTH_TOKEN. Never logs the content; every thrown message names
 * only the shape violation (key count, key name, malformed line), never a value.
 */
export function validateSingleTokenEnvContent(content: string): void {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("real-chat token env file is empty");
  }
  const entries = lines.map((line): readonly [string, string] => {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error("real-chat token env file has a malformed line (no key=value)");
    }
    return [line.slice(0, eq), line.slice(eq + 1)];
  });
  if (entries.length > 1) {
    throw new Error(
      `real-chat token env file must contain exactly one key (${REAL_CHAT_TOKEN_ENV_VAR}), found ${entries.length}`
    );
  }
  const [key, value] = entries[0]!;
  if (key !== REAL_CHAT_TOKEN_ENV_VAR) {
    throw new Error(
      `real-chat token env file's only key must be ${REAL_CHAT_TOKEN_ENV_VAR}, found a different key`
    );
  }
  if (value.length === 0) {
    throw new Error(
      `real-chat token env file's ${REAL_CHAT_TOKEN_ENV_VAR} value must not be empty`
    );
  }
}

/**
 * #1121 (Coordinator constraint 1): opt-in only — a no-op unless the operator set
 * JARVIS_UAT_REAL_CHAT_TOKEN_FILE to a GPG-encrypted file (real recipient key must already be in
 * the caller's default GPG keyring; argv below carries only paths, never token material).
 * Decrypts into a mode-0700 temp dir / mode-0600 file, validates its shape, and — only once
 * proven valid — exports JARVIS_UAT_REAL_CHAT_ENV_FILE so docker-compose.prod.yml's `seed`
 * service (and only that service) picks it up as its second env_file entry. Fails closed
 * (throws, cleans up the temp dir, never sets the result env var) on any invalid shape. This is
 * best-effort cleanup, not a guarantee of secure shredding.
 */
export async function writeUatRealChatEnvFile(): Promise<UatEnvFile | undefined> {
  const encryptedPath = process.env[REAL_CHAT_TOKEN_TRIGGER_ENV];
  if (!encryptedPath) {
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "jarv1s-uat-real-chat-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "real-chat.env");
  try {
    await execFileAsync("gpg", [
      "--batch",
      "--yes",
      "--decrypt",
      "--quiet",
      "--output",
      path,
      encryptedPath
    ]);
    chmodSync(path, 0o600);
    const content = readFileSync(path, "utf8");
    validateSingleTokenEnvContent(content);
  } catch (error) {
    rmSync(dir, { force: true, recursive: true });
    throw error;
  }
  process.env[REAL_CHAT_ENV_FILE_RESULT_ENV] = path;
  return { path, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}
