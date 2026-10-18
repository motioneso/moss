import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { API_KEY_CHAT_SEED_ENV, type ApiKeyChatSeed } from "./seed/types.js";

export type ApiKeyChatUatProvider = Omit<ApiKeyChatSeed, "apiKey"> & { readonly keyFile: string };

export const API_KEY_CHAT_CONTAINER_KEY_FILE = "/run/secrets/moss-uat-chat-key";

async function checkKeyFile(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(
      `The file named by ${API_KEY_CHAT_UAT_ENV.keyFile} must be a regular file with owner-only permissions`
    );
  }
}

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
  checkFile: (path: string) => Promise<void> = checkKeyFile
): Promise<ApiKeyChatUatProvider | undefined> {
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
  const keyFile = resolve(value(env, API_KEY_CHAT_UAT_ENV.keyFile));
  await checkFile(keyFile);
  return { providerKind: kind, baseUrl, model: value(env, API_KEY_CHAT_UAT_ENV.model), keyFile };
}

/** Only the seed container receives the read-only mount; environment carries its path. */
export function apiKeyChatSeedArgs(seed: ApiKeyChatUatProvider | undefined): string[] {
  return [
    ...(seed ? ["--volume", `${seed.keyFile}:${API_KEY_CHAT_CONTAINER_KEY_FILE}:ro`] : []),
    "-e",
    `${API_KEY_CHAT_SEED_ENV.kind}=${seed?.providerKind ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.baseUrl}=${seed?.baseUrl ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.model}=${seed?.model ?? ""}`,
    "-e",
    `${API_KEY_CHAT_SEED_ENV.keyFile}=${seed ? API_KEY_CHAT_CONTAINER_KEY_FILE : ""}`
  ];
}

/** Remove the obsolete plaintext-key variable even if the caller inherited it. */
export function apiKeyChatSeedProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.MOSS_UAT_API_KEY_CHAT_KEY;
  return env;
}
