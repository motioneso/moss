/**
 * Launch values for API-key chat rows. A failure to read the stored key becomes `null`,
 * never an error, so no decryption text can carry key material into a log.
 */
import { createHash } from "node:crypto";

import { MOSS_OPENCODE_PROVIDER_ID } from "@moss/acp";
import {
  parseAiApiKeyCredential,
  type AiProviderWithSealedCredential,
  type AiRepository,
  type AiSecretCipher
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";
import type { AiAuthMethod } from "@moss/shared";

export interface ChatCredential {
  readonly apiKey: string;
  readonly baseUrl: string | null;
  /** `providerLaunchRevision` of the row the key was read from. */
  readonly revision: string;
}

export interface ChatModelRow {
  readonly provider_kind: string;
  readonly provider_auth_method: AiAuthMethod;
  readonly provider_acp_agent_id: string | null;
  readonly provider_model_id: string;
}

type SealedChatProvider = Pick<
  AiProviderWithSealedCredential,
  | "provider_kind"
  | "auth_method"
  | "status"
  | "revoked_at"
  | "has_credential"
  | "base_url"
  | "encrypted_credential"
>;

/**
 * Non-secret identity of what a launch connects to. Hashes the kind, address and sealed
 * credential (ciphertext, never the key), so saving a new key or address changes it.
 */
export function providerLaunchRevision(
  row: Pick<AiProviderWithSealedCredential, "provider_kind" | "base_url" | "encrypted_credential">
): string {
  return createHash("sha256")
    .update(JSON.stringify([row.provider_kind, row.base_url ?? null, row.encrypted_credential]))
    .digest("hex");
}

/** The ACP model value for a live launch; `undefined` lets the engine use the row model. */
export function chatAcpModel(
  row: ChatModelRow,
  savedOpenCodeModel: string | null | undefined
): string | undefined {
  if (row.provider_auth_method === "api_key") {
    return row.provider_kind === "openai-compatible"
      ? `${MOSS_OPENCODE_PROVIDER_ID}/${row.provider_model_id}`
      : undefined;
  }
  if (row.provider_acp_agent_id !== "opencode") return undefined;
  return savedOpenCodeModel || undefined;
}

export function openChatCredential(
  row: SealedChatProvider | undefined,
  cipher: Pick<AiSecretCipher, "decryptJson"> | undefined
): ChatCredential | null {
  if (!row || !cipher) return null;
  if (row.auth_method !== "api_key" || row.status !== "active") return null;
  if (row.revoked_at || !row.has_credential) return null;
  try {
    const parsed = parseAiApiKeyCredential(cipher.decryptJson(row.encrypted_credential));
    return parsed
      ? { apiKey: parsed.apiKey, baseUrl: row.base_url, revision: providerLaunchRevision(row) }
      : null;
  } catch {
    return null;
  }
}

/** The cipher from `factory`, or `undefined` when the server cannot build one. */
export function chatCredentialCipher(
  factory: (() => AiSecretCipher) | undefined
): AiSecretCipher | undefined {
  try {
    return factory?.();
  } catch {
    return undefined;
  }
}

/** The launch revision of an API-key chat model's row; CLI rows carry none. */
export async function chatLaunchRevision(
  ai: Pick<AiRepository, "selectProviderWithCredential">,
  scopedDb: DataContextDb,
  model: (ChatModelRow & { readonly provider_config_id: string }) | null | undefined
): Promise<string | undefined> {
  if (model?.provider_auth_method !== "api_key") return undefined;
  const sealed = await ai.selectProviderWithCredential(scopedDb, model.provider_config_id);
  return sealed ? providerLaunchRevision(sealed) : undefined;
}
