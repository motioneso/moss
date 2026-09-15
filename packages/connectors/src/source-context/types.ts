import type { DataContextDb } from "@moss/db";

/**
 * Provider-neutral live-first source context (spec #729). Every item and per-account result
 * carries `source` so consumers (briefings/chat/Today) always know whether they are looking at a
 * live read or the fallback cache. Cache fallback is reserved for TRANSIENT failures only —
 * auth/grant/revocation problems surface as gaps so the user gets an actionable signal instead of
 * silently stale data.
 */

export type SourceMode = "live" | "cache";

export type SourceContextGapReason =
  | "auth_error"
  | "connector_revoked"
  | "feature_grant_disabled"
  | "unsupported_provider"
  | "service_unavailable";

export type DegradedReason =
  | "network_error"
  | "provider_error"
  | "rate_limited"
  | "timeout"
  | "internal_error";

export type EmailActionability =
  | "needs_reply"
  | "needs_action"
  | "time_sensitive_info"
  | "waiting_on_someone"
  | "fyi"
  | "noise"
  | "unknown";

export const EMAIL_ACTIONABILITY_VALUES: readonly EmailActionability[] = [
  "needs_reply",
  "needs_action",
  "time_sensitive_info",
  "waiting_on_someone",
  "fyi",
  "noise",
  "unknown"
];

export interface SourceAccountMeta {
  readonly connectorAccountId: string;
  readonly providerId: string;
  readonly providerLabel: string;
}

export interface EmailSuggestedTaskCandidate {
  readonly title: string;
  readonly dueDate: string | null;
}

export interface EmailContextItem {
  /** Provider-stable external message id — never a cache row id. */
  readonly messageKey: string;
  readonly account: SourceAccountMeta;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly receivedAt: string;
  readonly threadId: string | null;
  /** Stable provider deep link when the provider exposes one; IMAP is null in v1. */
  readonly sourceHref: string | null;
  readonly snippet: string | null;
  /** Bounded, body-echo-guarded triage summary. Full bodies never leave triage internals. */
  readonly summary: string | null;
  readonly actionability: EmailActionability;
  readonly importance: "low" | "normal" | "high";
  readonly confidence: number;
  readonly reason: string | null;
  /** Guarded model-written subject used only for action-row suppression matching. */
  readonly inferredSubject?: string | null;
  readonly dueDate: string | null;
  readonly suggestedTasks: readonly EmailSuggestedTaskCandidate[];
  readonly source: SourceMode;
  readonly degradedReason: DegradedReason | null;
  /** Cached row id when one exists — reply flows address via the cached message. */
  readonly cacheMessageId: string | null;
}

export type CalendarContextFlag = "conflict" | "early" | "late" | "has_location" | "prep_attendees";

export interface CalendarContextItem {
  readonly eventKey: string;
  readonly account: SourceAccountMeta;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly attendeeCount: number;
  readonly flags: readonly CalendarContextFlag[];
  readonly source: SourceMode;
  readonly degradedReason: DegradedReason | null;
}

export interface SourceContextAccountResult {
  readonly account: SourceAccountMeta;
  readonly source: SourceMode;
  readonly degradedReason: DegradedReason | null;
  /** This account's own freshness: the observation time when live, its last completed sync when cached. Calendar-only for now. */
  readonly asOf?: string | null;
}

export interface SourceContextGap {
  readonly account: SourceAccountMeta | null;
  readonly reason: SourceContextGapReason;
}

export interface EmailContextResult {
  readonly items: readonly EmailContextItem[];
  readonly accounts: readonly SourceContextAccountResult[];
  readonly gaps: readonly SourceContextGap[];
}

export interface CalendarContextResult {
  readonly items: readonly CalendarContextItem[];
  readonly accounts: readonly SourceContextAccountResult[];
  readonly gaps: readonly SourceContextGap[];
  /** True when more matching events existed than `items` returned (see `limit`). */
  readonly truncated: boolean;
  /**
   * The least-fresh contributing account's time: for a live account, the read's observation
   * time; for a cache-fallback account, that account's last completed sync. Null if any
   * contributing account's freshness is unknown.
   */
  readonly asOf: string | null;
}

export interface ListEmailContextInput {
  readonly limitPerAccount?: number;
}

export interface ListCalendarContextInput {
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly limit?: number;
}

export interface SourceContextService {
  listEmailContext(
    scopedDb: DataContextDb,
    input: ListEmailContextInput
  ): Promise<EmailContextResult>;
  listCalendarContext(
    scopedDb: DataContextDb,
    input: ListCalendarContextInput
  ): Promise<CalendarContextResult>;
}

export type LiveReadFailure =
  | { readonly kind: "transient"; readonly degradedReason: DegradedReason }
  | { readonly kind: "auth" };

const NETWORK_CODES = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE"];

/**
 * Spec §4 failure classification. Auth (401/403) → gap, never cache. Everything else is
 * transient: rate limit, provider outage, network, timeout — including unknown internal errors
 * (an internal live-read failure must not hide data the fallback cache still has).
 */
export function classifyLiveReadFailure(error: unknown): LiveReadFailure {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : undefined;
  if (statusCode === 401 || statusCode === 403) return { kind: "auth" };
  if (statusCode === 429) return { kind: "transient", degradedReason: "rate_limited" };
  if (statusCode !== undefined && Number.isFinite(statusCode) && statusCode >= 400) {
    return { kind: "transient", degradedReason: "provider_error" };
  }
  if (error instanceof Error) {
    const message = error.message;
    if (error.name === "AbortError" || /ETIMEDOUT|timed?\s?out|timeout/i.test(message)) {
      return { kind: "transient", degradedReason: "timeout" };
    }
    if (error instanceof TypeError || NETWORK_CODES.some((code) => message.includes(code))) {
      return { kind: "transient", degradedReason: "network_error" };
    }
  }
  return { kind: "transient", degradedReason: "internal_error" };
}
