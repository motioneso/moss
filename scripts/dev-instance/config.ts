import { homedir } from "node:os";
import { join } from "node:path";

import { resolveMossEnv } from "@moss/db";
import type { AiProviderKind } from "@moss/db";

/**
 * Config contract for the dev-instance CLI (#1258). `readDevInstanceConfig`, which reads these
 * fields from the environment, is built in Phase 2 (task T9) — this type is declared here first
 * because `doctor.ts`'s `DoctorDeps` (Phase 1) already needs the shape to compile against.
 */
export type DevInstanceProviderAuth = "cli" | "api_key";

export interface DevInstanceConfig {
  readonly providerKind: AiProviderKind;
  // "api_key" registers an API-key provider row instead of the CLI login (#3410).
  readonly providerAuth: DevInstanceProviderAuth;
  readonly providerBaseUrl: string | null;
  readonly providerKeyFilePath: string | null;
  readonly credentialFilePath: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPasswordFilePath: string;
  readonly cliHomeBase: string;
  readonly cliRunnerSocketPath: string;
}

const VALID_PROVIDER_KINDS: readonly AiProviderKind[] = [
  "openai-compatible",
  "anthropic",
  "google",
  "ollama",
  "custom"
];

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// Chat can drive API-key rows of these kinds only (#3410).
const API_KEY_PROVIDER_KINDS: readonly AiProviderKind[] = ["anthropic", "openai-compatible"];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readProviderAccess(
  env: NodeJS.ProcessEnv,
  providerKind: AiProviderKind
): Pick<DevInstanceConfig, "providerAuth" | "providerBaseUrl" | "providerKeyFilePath"> {
  const auth = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_AUTH") || "cli";
  const baseUrl = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_BASE_URL") || null;
  const keyFile = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE") || null;

  if (auth === "cli") {
    if (baseUrl !== null || keyFile !== null) {
      throw new Error(
        "MOSS_DEV_INSTANCE_PROVIDER_BASE_URL and MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE apply only " +
          "when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key"
      );
    }
    return { providerAuth: "cli", providerBaseUrl: null, providerKeyFilePath: null };
  }
  if (auth !== "api_key") {
    throw new Error(`Invalid dev-instance providerAuth "${auth}". Must be one of: cli, api_key`);
  }
  if (!API_KEY_PROVIDER_KINDS.includes(providerKind)) {
    throw new Error(
      `An api_key dev instance needs providerKind anthropic or openai-compatible, not "${providerKind}"`
    );
  }
  if (keyFile === null) {
    throw new Error(
      "MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE is required when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key"
    );
  }
  if (baseUrl !== null && !isHttpUrl(baseUrl)) {
    throw new Error("MOSS_DEV_INSTANCE_PROVIDER_BASE_URL must be an http:// or https:// address");
  }
  return {
    providerAuth: "api_key",
    providerBaseUrl: baseUrl,
    providerKeyFilePath: expandHome(keyFile)
  };
}

export function readDevInstanceConfig(env: NodeJS.ProcessEnv): DevInstanceConfig {
  const providerKind = resolveMossEnv(env, "MOSS_DEV_INSTANCE_PROVIDER_KIND") ?? "anthropic";
  if (!VALID_PROVIDER_KINDS.includes(providerKind as AiProviderKind)) {
    throw new Error(
      `Invalid dev-instance providerKind "${providerKind}". Must be one of: ` +
        VALID_PROVIDER_KINDS.join(", ")
    );
  }

  return {
    providerKind: providerKind as AiProviderKind,
    ...readProviderAccess(env, providerKind as AiProviderKind),
    credentialFilePath: expandHome(
      resolveMossEnv(env, "MOSS_DEV_INSTANCE_CREDENTIAL_FILE") ??
        "~/.config/moss/uat/anthropic-oauth.env.gpg"
    ),
    adminEmail: resolveMossEnv(env, "JARVIS_DEV_EMAIL") ?? "ben@ben.com",
    adminName: resolveMossEnv(env, "MOSS_DEV_INSTANCE_ADMIN_NAME") ?? "Ben",
    adminPasswordFilePath: expandHome(
      resolveMossEnv(env, "MOSS_DEV_INSTANCE_ADMIN_PASSWORD_FILE") ??
        "~/.config/moss/dev/admin-password"
    ),
    cliHomeBase: expandHome(
      resolveMossEnv(env, "JARVIS_CLI_HOME_BASE") ?? "~/.local/share/moss/cli-auth"
    ),
    cliRunnerSocketPath:
      resolveMossEnv(env, "JARVIS_CLI_RUNNER_SOCKET") ?? "/run/jarv1s/cli-runner.sock"
  };
}
