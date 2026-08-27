// packages/news/src/publisher-connection-port.ts
// #2005 — the seam to #2007. This slice must prove "a key is checked before anything is
// written" without owning the outbound request, so News declares the shape and the
// composition root supplies it. Until #2007 merges the injected implementation knows no
// connections, so every connect attempt answers "unsupported". That is intended.

/** A reviewed publisher connection. #2007 defines the real ones; this slice only reads. */
export interface NewsConnectionDescriptor {
  readonly connectionId: string;
  readonly publisherName: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape";
  /** Exact host the key will be sent to, shown to the user before they submit it. */
  readonly host: string;
}

export type NewsCredentialValidationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unsupported" | "rejected" | "unavailable" };

export interface NewsPublisherConnectionPort {
  describe(connectionId: string): NewsConnectionDescriptor | undefined;
  /**
   * SECURITY: implementations must never put the key, or any part of it, into a returned
   * value, a thrown error, or a log line. Callers treat a thrown error as "unavailable".
   */
  validateKey(connectionId: string, apiKey: string): Promise<NewsCredentialValidationOutcome>;
}

/**
 * The do-nothing implementation this slice ships with: no connection is known, so no key
 * can be validated and nothing is ever written. #2007 replaces it with the reviewed
 * NewsAPI connection.
 */
export function createEmptyNewsPublisherConnectionPort(): NewsPublisherConnectionPort {
  return {
    describe: () => undefined,
    validateKey: async () => ({ ok: false, reason: "unsupported" })
  };
}
