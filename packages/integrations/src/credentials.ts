import { JsonSecretCipher, resolveKeyring } from "@moss/db";
import type { CredentialPlacement } from "@moss/shared";

export function createIntegrationsCipher(env: NodeJS.ProcessEnv = process.env): JsonSecretCipher {
  return new JsonSecretCipher(
    resolveKeyring(
      "JARVIS_INTEGRATIONS_SECRET_KEY",
      "JARVIS_INTEGRATIONS_SECRET_KEY_ID",
      "JARVIS_INTEGRATIONS_SECRET_KEYS",
      "jarv1s-development-integrations-secret",
      env
    ),
    "integration credential"
  );
}

export function applyCredential(
  placement: CredentialPlacement | null,
  secret: string | null,
  url: URL,
  headers: Headers
): void {
  if (!secret) return;
  const kind = placement?.kind ?? "bearer";
  if (kind === "bearer") headers.set("authorization", `Bearer ${secret}`);
  else if (kind === "header") headers.set(placement?.name ?? "X-Api-Key", secret);
  else url.searchParams.set(placement?.name ?? "apikey", secret);
}
