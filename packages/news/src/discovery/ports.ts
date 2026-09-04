import type { DataContextDb } from "@moss/db";

export interface NewsSafeFetchResult {
  readonly ok: true;
  readonly status: number;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: string;
  readonly truncated: boolean;
}

export interface NewsSafeFetchFailure {
  readonly ok: false;
  readonly reason:
    | "blocked"
    | "robots"
    | "rate_limited"
    | "http_error"
    | "challenge"
    | "timeout"
    | "network"
    | "not_https";
  readonly status?: number;
}

export type NewsSafeFetchPort = (
  url: string
) => Promise<NewsSafeFetchResult | NewsSafeFetchFailure>;

export type NewsImageFetchPort = (
  url: string,
  maxBytes: number,
  /**
   * When supplied, the fetch (including every redirect hop) must land on one of these hosts or
   * it is refused — how the favicon route keeps a redirect from carrying an approved request off
   * to an arbitrary site.
   */
  allowedHosts?: readonly string[]
) => Promise<
  | {
      readonly ok: true;
      readonly contentType: string | null;
      readonly body: Uint8Array;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "blocked"
        | "robots"
        | "rate_limited"
        | "http_error"
        | "timeout"
        | "network"
        | "not_https";
    }
>;

export interface NewsWebSearchPort {
  search(
    scopedDb: DataContextDb,
    query: string,
    opts: { limit: number; freshness?: "day" | "week" }
  ): Promise<{
    results: { title: string; url: string; snippet: string; publishedAt?: string }[];
  }>;
}

export interface NewsAiPort {
  generateJson(
    scopedDb: DataContextDb,
    input: { schema: Record<string, unknown>; prompt: string; maxOutputTokens?: number }
  ): Promise<
    | { ok: true; object: unknown }
    | {
        ok: false;
        error: "needs_config" | "validation_failed" | "provider_error" | "aborted";
      }
  >;
  fingerprint(scopedDb: DataContextDb): Promise<string | null>;
}
