import {
  PROVIDER_REJECTED_CREDENTIAL_MESSAGE,
  type ProviderKind,
  testProviderCredential
} from "@moss/ai";

import type { RpcAcpSpawnCredential } from "./rpc-contract.js";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Asks the provider once, with the stored key, whether it refuses that key. This is the same
 * check that marks the settings card "rejected", so a 401 or 403 is the only true answer.
 */
export function apiKeyRejectionProbe(
  provider: ProviderKind,
  credential: RpcAcpSpawnCredential,
  baseFetch: typeof fetch = fetch
): () => Promise<boolean> {
  return async () => {
    if (provider !== "anthropic" && provider !== "openai-compatible") return false;
    const result = await testProviderCredential({
      providerKind: provider,
      authMethod: "api_key",
      // The stored address goes through untouched: the key test owns the address rule, and a
      // pre-normalized value would already have lost a custom version path such as /api/v1
      // before that rule saw it (#3559).
      baseUrl: credential.baseUrl,
      credential: { apiKey: credential.apiKey },
      fetch: (url, init) =>
        baseFetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    });
    return !result.ok && result.message === PROVIDER_REJECTED_CREDENTIAL_MESSAGE;
  };
}
