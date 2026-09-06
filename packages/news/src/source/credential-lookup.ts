// packages/news/src/source/credential-lookup.ts
// #2007 — turns a stored credential row into the runtime's answer: usable key, or one of three
// reasons it is not usable.
//
// #2005 landed before this slice was built, so this is wired to its real repository rather than
// left as a stand-in. The plaintext key exists only inside the returned success value, which the
// runtime hands straight to the adapter and then drops; nothing here logs, caches or rethrows it.
import type { DataContextDb, EncryptedSecret } from "@moss/db";

import type { NewsCredentialLookupPort } from "./credential-lookup-port.js";

/** What the lookup needs from the credential store. The repository satisfies this. */
export interface NewsCredentialEnvelopeReader {
  readCredentialForUse(
    scopedDb: DataContextDb,
    sourceId: string
  ): Promise<
    | {
        readonly status: "configured";
        readonly connectionId: string;
        readonly envelope: EncryptedSecret;
        readonly generation: string;
      }
    | { readonly status: "revoked" }
    | null
  >;
}

export function createNewsCredentialLookup(deps: {
  readonly reader: NewsCredentialEnvelopeReader;
  /**
   * Per-use credential reader, built in the composition root where key
   * resolution lives (never in this feature module). Null means the family key
   * exists nowhere and maps to missing; a throw means unreadable. Either way
   * the refresh carries on with the other sources.
   */
  readonly decryptApiKey: (
    credentialContext: DataContextDb,
    envelope: EncryptedSecret
  ) => Promise<{ readonly apiKey: string } | null>;
}): NewsCredentialLookupPort {
  return async ({ sourceId, credentialContext }) => {
    // No owner filter here on purpose: the row is fetched under the acting person's row
    // security, so Postgres decides whose row is visible. A WHERE clause on the owner would be
    // a second, weaker copy of that rule.
    const row = await deps.reader.readCredentialForUse(credentialContext, sourceId);
    if (row === null) return { ok: false, reason: "missing" };
    if (row.status === "revoked") return { ok: false, reason: "revoked" };

    let apiKey: string;
    try {
      const decrypted = await deps.decryptApiKey(credentialContext, row.envelope);
      if (!decrypted) return { ok: false, reason: "missing" };
      apiKey = decrypted.apiKey;
    } catch {
      // Swallowed deliberately: a cipher error names the keyring entry and sometimes the
      // envelope, and neither belongs in anything the caller can see or log.
      return { ok: false, reason: "unreadable" };
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      // A row that decrypts to nothing is broken, not empty-but-fine; sending a blank key would
      // read as an authentication failure and send the person hunting the wrong problem.
      return { ok: false, reason: "unreadable" };
    }

    return { ok: true, apiKey, generation: row.generation };
  };
}
