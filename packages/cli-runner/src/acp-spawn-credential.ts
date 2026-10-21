import { PROVIDER_MODEL_ID_PATTERN, providerBaseUrlHasUserInfo } from "@moss/ai";
import type { RpcAcpSpawnCredential } from "@moss/chat/live";

/** Refusal for a malformed credential. Messages name the field, never its value. */
export class AcpCredentialBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpCredentialBadRequestError";
  }
}

const CREDENTIAL_KEYS = "apiKey,baseUrl,model";
const API_KEY = /^[\x21-\x7e]{1,4096}$/;

export function readAcpSpawnCredential(
  raw: unknown,
  providerKind: string,
  profile: string
): RpcAcpSpawnCredential | null {
  if (raw === undefined) return null;
  if ((providerKind !== "anthropic" && providerKind !== "opencode") || profile !== "chat") {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential is accepted only for anthropic or opencode chat spawns"
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AcpCredentialBadRequestError("acpSpawn.credential must be an object");
  }
  if (Object.keys(raw).sort().join(",") !== CREDENTIAL_KEYS) {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential must have exactly baseUrl, apiKey and model"
    );
  }
  const { apiKey, baseUrl, model } = raw as Record<string, unknown>;
  if (typeof apiKey !== "string" || !API_KEY.test(apiKey)) {
    throw new AcpCredentialBadRequestError("acpSpawn.credential.apiKey is malformed");
  }
  if (baseUrl !== null && !isHttpUrl(baseUrl)) {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential.baseUrl must be null or an http(s) URL"
    );
  }
  if (baseUrl !== null && providerBaseUrlHasUserInfo(baseUrl)) {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential.baseUrl must not include a username or password"
    );
  }
  if (typeof model !== "string" || !PROVIDER_MODEL_ID_PATTERN.test(model)) {
    throw new AcpCredentialBadRequestError("acpSpawn.credential.model is malformed");
  }
  return { apiKey, baseUrl, model };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
