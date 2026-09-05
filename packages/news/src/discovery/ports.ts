import type { DataContextDb } from "@moss/db";

export interface NewsSafeFetchResult {
  readonly ok: true;
  readonly status: number;
  readonly finalUrl: string;
  readonly hopCount?: number;
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
  /**
   * #2282: the web fetch helper's finer cause when it has one (aborted, invalid_response,
   * response_too_large, unsupported_content_type). Kept as a plain string so the port never
   * has to chase the helper's union.
   */
  readonly detail?: string;
  /** #2282: raw Retry-After header value on `rate_limited`; callers apply their own bounded policy. */
  readonly retryAfter?: string;
}

export type NewsSafeFetchPort = (
  url: string
) => Promise<NewsSafeFetchResult | NewsSafeFetchFailure>;

export interface NewsFetchRequestHop {
  readonly url: URL;
  readonly redirectCount: number;
}

/**
 * #2282 task 1.5: per-call options for the options-capable fetch port. Every field is optional
 * and shaped so the shared Reddit reader's `RedditFetchOptions` is assignable here as-is.
 */
export interface NewsFetchOptions {
  readonly allowedHosts?: readonly string[];
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  readonly allowedContentTypes?: readonly string[];
  readonly beforeRequest?: (hop: NewsFetchRequestHop) => boolean | void | Promise<boolean | void>;
  readonly maxBytes?: number;
  readonly rejectOversizedResponses?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Skip the robots gate for this one call. Reddit's robots rules refuse generic agents, so the
   * Reddit reader asks for this; every other caller keeps the gate.
   */
  readonly skipRobots?: boolean;
}

/**
 * The options-capable sibling of `NewsSafeFetchPort`. The URL-only port stays as it is for every
 * current caller; this one exists for the Reddit reader and the feed finder.
 */
export type NewsFetchPort = (
  url: string,
  options?: NewsFetchOptions
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
