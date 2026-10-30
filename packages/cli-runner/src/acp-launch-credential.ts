/**
 * Puts a chat agent's credential into its environment. An API-key launch gets the row's
 * address, key and model; a CLI-login claude launch gets the stored login token. Keys travel
 * only by environment, never by argument or settings file.
 */
import { readFile } from "node:fs/promises";
import {
  MOSS_OPENCODE_API_KEY_ENV,
  MOSS_OPENCODE_PROVIDER_ID,
  type AcpProviderKind
} from "@moss/acp";
import { providerBaseUrl } from "@moss/ai";
import type { RpcAcpSpawnCredential } from "@moss/chat/live";

import type { AgentHomeOpencodeProvider } from "./agent-home-prepare-run.js";
import { providerTokenPath } from "./provider-token-store.js";

export type AcpCredential = RpcAcpSpawnCredential;

export interface AgentCredentialLaunch {
  /**
   * The OpenCode settings file this ONE launch owns (#3558). Each launch reads its own file
   * through XDG_CONFIG_HOME, so writing or clearing a provider entry here can never change
   * what an overlapping launch of the same person sees.
   */
  readonly configPath: string | null;
  readonly homeBase: string;
  readonly providerKind: AcpProviderKind;
  readonly credential: AcpCredential | null;
  readonly readTokenFile?: (path: string) => Promise<string>;
}

/**
 * Sets the credential variables on `env`. For OpenCode it also returns the settings change:
 * the Moss provider entry for an API-key launch, or its removal for any other launch.
 */
export async function applyAgentCredential(
  env: NodeJS.ProcessEnv,
  launch: AgentCredentialLaunch
): Promise<AgentHomeOpencodeProvider | undefined> {
  const { credential, providerKind } = launch;
  if (providerKind === "anthropic") {
    if (credential) {
      if (credential.baseUrl !== null) {
        env.ANTHROPIC_BASE_URL = providerBaseUrl("anthropic", credential.baseUrl);
      }
      env.ANTHROPIC_API_KEY = credential.apiKey;
      env.ANTHROPIC_MODEL = credential.model;
    } else {
      const token = await readLoginToken(launch);
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
    return undefined;
  }
  if (providerKind !== "opencode") return undefined;

  const path = launch.configPath;
  if (!path) throw new Error("an OpenCode launch needs its own settings path");
  if (!credential) return { path, id: MOSS_OPENCODE_PROVIDER_ID, entry: null };
  env[MOSS_OPENCODE_API_KEY_ENV] = credential.apiKey;
  return {
    path,
    id: MOSS_OPENCODE_PROVIDER_ID,
    entry: {
      baseUrl: `${providerBaseUrl("openai-compatible", credential.baseUrl)}/v1`,
      model: credential.model,
      apiKeyEnv: MOSS_OPENCODE_API_KEY_ENV
    }
  };
}

async function readLoginToken(launch: AgentCredentialLaunch): Promise<string | null> {
  try {
    const read = launch.readTokenFile ?? ((path: string) => readFile(path, "utf8"));
    const token = (await read(providerTokenPath(launch.homeBase, "anthropic"))).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
