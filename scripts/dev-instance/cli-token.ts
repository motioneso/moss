/**
 * dev-instance token step (#1258, Phase 3).
 *
 * The database row for a CLI-authenticated provider carries only a sealed sentinel — the real
 * credential is a token file under the cli-runner's home base. Without it the provider row
 * resolves and every chat turn still fails at request time, which is exactly the "chat is broken
 * after a database reset" symptom this issue exists to kill.
 *
 * The token is a long-lived first-party credential. It is written through the cli-runner's own
 * store (0600, atomic) and never returned, never logged, and never passed as an argv value —
 * callers get a boolean saying whether anything changed.
 */
import { isTokenProvider, persistProviderToken, readProviderToken } from "@moss/cli-runner";
import type { RpcProviderKind } from "@moss/chat/live";
import type { AiProviderKind } from "@moss/db";

import type { DevInstanceConfig } from "./config.js";

/**
 * The provider kinds that authenticate with a stored CLI token. `AiProviderKind` (a database
 * column) and `RpcProviderKind` (a cli-runner concept) are separate vocabularies that happen to
 * overlap; this is the only place the dev CLI crosses between them.
 */
const TOKEN_PROVIDER_KINDS: Partial<Record<AiProviderKind, RpcProviderKind>> = {
  anthropic: "anthropic"
};

/** The cli-runner provider this database provider kind logs in as, or null if it uses no token. */
export function tokenProviderFor(kind: AiProviderKind): RpcProviderKind | null {
  const mapped = TOKEN_PROVIDER_KINDS[kind];
  return mapped && isTokenProvider(mapped) ? mapped : null;
}

/**
 * Write the provider's login token where the cli-runner reads it. Returns whether anything
 * changed, so a second `provision` on an already-good instance reports a clean no-op.
 */
export async function persistCliRunnerToken(
  config: DevInstanceConfig,
  token: string
): Promise<boolean> {
  const provider = tokenProviderFor(config.providerKind);
  if (!provider) {
    throw new Error(
      `provider kind "${config.providerKind}" does not authenticate with a stored CLI token — ` +
        "nothing to persist"
    );
  }
  if (token.trim().length === 0) {
    throw new Error("refusing to persist an empty CLI token");
  }

  const existing = await readProviderToken(config.cliHomeBase, provider);
  if (existing === token.trim()) return false;

  await persistProviderToken(config.cliHomeBase, provider, token.trim());
  return true;
}
