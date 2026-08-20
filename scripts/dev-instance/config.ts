import { homedir } from "node:os";
import { join } from "node:path";

import { resolveMossEnv } from "@moss/db";
import type { AiProviderKind } from "@moss/db";

/**
 * Config contract for the dev-instance CLI (#1258). `readDevInstanceConfig`, which reads these
 * fields from the environment, is built in Phase 2 (task T9) — this type is declared here first
 * because `doctor.ts`'s `DoctorDeps` (Phase 1) already needs the shape to compile against.
 */
export interface DevInstanceConfig {
  readonly providerKind: AiProviderKind;
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
