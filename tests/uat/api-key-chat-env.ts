import { readSecretFile } from "../../scripts/dev-instance/secrets.js";
import { API_KEY_CHAT_SEED_ENV, type ApiKeyChatSeed } from "./seed/types.js";

export type { ApiKeyChatSeed };

/** #3410: host settings for the opt-in API-key chat UAT. All four, or none. */
export const API_KEY_CHAT_UAT_ENV = {
  kind: "MOSS_UAT_CHAT_PROVIDER_KIND",
  baseUrl: "MOSS_UAT_CHAT_PROVIDER_BASE_URL",
  model: "MOSS_UAT_CHAT_PROVIDER_MODEL",
  keyFile: "MOSS_UAT_CHAT_PROVIDER_KEY_FILE"
} as const;

const NAMES = Object.values(API_KEY_CHAT_UAT_ENV);

function value(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] ?? "";
}

export function apiKeyChatUatConfigured(env: NodeJS.ProcessEnv): boolean {
  return NAMES.every((name) => value(env, name) !== "");
}

/** Errors name variables only. Values can be private addresses or paths. */
export async function readApiKeyChatUatProvider(
  env: NodeJS.ProcessEnv,
  readKeyFile: (path: string) => Promise<string> = readSecretFile
): Promise<ApiKeyChatSeed | undefined> {
  const missing = NAMES.filter((name) => value(env, name) === "");
  if (missing.length === NAMES.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`API-key chat UAT needs ${NAMES.join(", ")}; missing ${missing.join(", ")}`);
  }

  const kind = value(env, API_KEY_CHAT_UAT_ENV.kind);
  if (kind !== "anthropic" && kind !== "openai-compatible") {
    throw new Error(`${API_KEY_CHAT_UAT_ENV.kind} must be anthropic or openai-compatible`);
  }
  const baseUrl = value(env, API_KEY_CHAT_UAT_ENV.baseUrl);
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(`${API_KEY_CHAT_UAT_ENV.baseUrl} must start with http:// or https://`);
  }
  const apiKey = (await readKeyFile(value(env, API_KEY_CHAT_UAT_ENV.keyFile))).trim();
  if (apiKey === "") {
    throw new Error(`The file named by ${API_KEY_CHAT_UAT_ENV.keyFile} is empty`);
  }

  return { providerKind: kind, baseUrl, model: value(env, API_KEY_CHAT_UAT_ENV.model), apiKey };
}

/** Always passed, empty means off. The key is a name-only flag. */
export function apiKeyChatSeedArgs(seed: ApiKeyChatSeed | undefined): string[] {
  return [
    "-e",
    `${API_KEY_CHAT_SEED_ENV.kind}=${seed?.providerKind ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.baseUrl}=${seed?.baseUrl ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.model}=${seed?.model ?? ""}`,
    "-e",
    API_KEY_CHAT_SEED_ENV.key
  ];
}

/** The docker child env. The key is set last, so a stray host value never leaks through. */
export function apiKeyChatSeedProcessEnv(
  seed: ApiKeyChatSeed | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...base, [API_KEY_CHAT_SEED_ENV.key]: seed?.apiKey ?? "" };
}
