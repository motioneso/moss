import type {
  ConnectorAccountStatus,
  ConnectorProviderType,
  ConnectorSyncCounts,
  ConnectorSyncStatus
} from "./connectors-api.js";

/**
 * Single source of truth for connector sync wording. Every screen and the Moss status
 * tool call `explainConnectorSync` (and, for lost-ability notices, `deriveNotWorking`)
 * rather than composing their own sentences, so the words only ever live in one place.
 *
 * Counts only, never content: nothing here ever carries a subject, sender, event title,
 * message id, or token material.
 */

/**
 * How long a queued (not yet "active") job can sit before we tell the user the
 * background worker may not be running. A connectors-package constant, not a setting.
 */
export const WAITING_FOR_WORKER_GRACE_MS = 120_000;

export type ConnectorSyncPendingState = "queued" | "active" | "waiting-for-worker";

export interface ConnectorSyncPending {
  readonly state: ConnectorSyncPendingState;
  /** When this job entered its current pending state. */
  readonly since: string;
}

export interface ConnectorDeferredAi {
  /** How many messages this run set aside for the assistant to catch up on later. */
  readonly count: number;
  /** Already human-readable — the AI router's reported reason, not a raw error code. */
  readonly reason: string;
}

export type ConnectorSyncExplainCode =
  | "revoked"
  | "syncing"
  | "queued"
  | "waiting-for-worker"
  | "sign-in-expired"
  | "connection-error"
  | "partial"
  | "capped"
  | "first-run-pending"
  | "synced"
  | "not-scheduled";

export type ConnectorSyncTone = "forest" | "amber" | "red" | "neutral";

export interface ExplainConnectorSyncInput {
  readonly providerType: ConnectorProviderType;
  readonly status: ConnectorAccountStatus;
  readonly lastSyncStartedAt: string | null;
  readonly lastSyncFinishedAt: string | null;
  readonly lastSyncStatus: ConnectorSyncStatus | null;
  readonly lastSyncError: string | null;
  readonly lastSyncCounts: ConnectorSyncCounts | null;
  readonly pending: ConnectorSyncPending | null;
  readonly nextRunAt: string | null;
  readonly deferredAi: ConnectorDeferredAi | null;
}

export interface ExplainConnectorSyncResult {
  readonly code: ConnectorSyncExplainCode;
  readonly tone: ConnectorSyncTone;
  /** Short badge text. */
  readonly label: string;
  /** One sentence: what happened and when. */
  readonly summary: string;
  /** Why, in plain words, when something failed. Null when nothing needs explaining. */
  readonly reason: string | null;
  /** What happens next. Null when there is nothing more to say. */
  readonly next: string | null;
  readonly canReconnect: boolean;
  readonly canSyncNow: boolean;
}

export function explainConnectorSync(
  input: ExplainConnectorSyncInput,
  now: Date
): ExplainConnectorSyncResult {
  const nowMs = now.getTime();

  if (input.status === "revoked") {
    return build("revoked", {
      summary: "This connection was revoked.",
      reason: null,
      next: null,
      canReconnect: false,
      canSyncNow: false
    });
  }

  if (input.pending) {
    if (input.pending.state === "active") {
      return build("syncing", {
        summary: "Sync is running.",
        reason: null,
        next: `Started ${formatRelative(input.pending.since, nowMs)}.`,
        canReconnect: false,
        canSyncNow: false
      });
    }
    if (input.pending.state === "queued") {
      return build("queued", {
        summary: "Sync is queued.",
        reason: null,
        next: "Waiting for the background worker to pick it up.",
        canReconnect: false,
        canSyncNow: false
      });
    }
    return build("waiting-for-worker", {
      summary: "Sync has not started.",
      reason: `Queued ${formatRelative(input.pending.since, nowMs)} and not picked up.`,
      next: "The background worker may not be running.",
      canReconnect: false,
      canSyncNow: true
    });
  }

  if (input.lastSyncStatus === "failed") {
    const isAuthFailure = input.lastSyncError === "auth-error";
    if (isAuthFailure) {
      return build("sign-in-expired", {
        summary: `Last run ${formatRelative(input.lastSyncFinishedAt, nowMs)} failed to sign in.`,
        reason: `${providerLabel(input.providerType)} no longer accepts the saved sign-in.`,
        next: "Press Reconnect.",
        canReconnect: true,
        canSyncNow: false
      });
    }
    return build("connection-error", {
      summary: `Last run ${formatRelative(input.lastSyncFinishedAt, nowMs)} could not connect.`,
      reason: errorCodeSentence(input.lastSyncError, input.lastSyncCounts),
      next: "Press Reconnect, or check the server can reach the provider.",
      canReconnect: true,
      canSyncNow: true
    });
  }

  if (input.status === "error") {
    return build("connection-error", {
      summary: `${providerLabel(input.providerType)} reported a connection error.`,
      reason: `There is no active connection for this account.`,
      next: "Press Reconnect, or check the server can reach the provider.",
      canReconnect: true,
      canSyncNow: true
    });
  }

  if (input.lastSyncStatus === "partial") {
    const capped = Boolean(input.lastSyncCounts?.truncated) && !input.lastSyncError;
    if (capped) {
      return build("capped", {
        summary: `Last run ${formatRelative(input.lastSyncFinishedAt, nowMs)} reached the message cap.`,
        reason: `Stopped at the message cap; ${input.lastSyncCounts?.emailUpserted ?? 0} emails so far.`,
        next: "Continues automatically in the next run.",
        canReconnect: false,
        canSyncNow: true
      });
    }
    return build("partial", {
      summary: `Last run ${formatRelative(input.lastSyncFinishedAt, nowMs)} finished with errors.`,
      reason: errorCodeSentence(input.lastSyncError, input.lastSyncCounts),
      next: "The next run will retry what failed.",
      canReconnect: false,
      canSyncNow: true
    });
  }

  if (input.lastSyncStatus === null) {
    if (input.nextRunAt === null) {
      return build("not-scheduled", {
        summary: "No sync is scheduled.",
        reason: null,
        next: "Reconnect to schedule syncing.",
        canReconnect: true,
        canSyncNow: false
      });
    }
    return build("first-run-pending", {
      summary: "The first sync has not run yet.",
      reason: null,
      next: `Scheduled for ${formatClockTime(input.nextRunAt)}.`,
      canReconnect: false,
      canSyncNow: true
    });
  }

  return build("synced", {
    summary: buildSyncedSummary(input, nowMs),
    reason: null,
    next: input.nextRunAt ? `Next check at ${formatClockTime(input.nextRunAt)}.` : null,
    canReconnect: false,
    canSyncNow: true
  });
}

const LABELS: Record<ConnectorSyncExplainCode, string> = {
  revoked: "Revoked",
  syncing: "Syncing",
  queued: "Queued",
  "waiting-for-worker": "Waiting for worker",
  "sign-in-expired": "Sign-in expired",
  "connection-error": "Connection error",
  partial: "Partial sync",
  capped: "More to fetch",
  "first-run-pending": "First sync pending",
  synced: "Synced",
  "not-scheduled": "Not scheduled"
};

const TONES: Record<ConnectorSyncExplainCode, ConnectorSyncTone> = {
  revoked: "neutral",
  syncing: "neutral",
  queued: "neutral",
  "waiting-for-worker": "neutral",
  "sign-in-expired": "red",
  "connection-error": "red",
  partial: "amber",
  capped: "amber",
  "first-run-pending": "neutral",
  synced: "forest",
  "not-scheduled": "neutral"
};

function build(
  code: ConnectorSyncExplainCode,
  parts: {
    summary: string;
    reason: string | null;
    next: string | null;
    canReconnect: boolean;
    canSyncNow: boolean;
  }
): ExplainConnectorSyncResult {
  return {
    code,
    tone: TONES[code],
    label: LABELS[code],
    ...parts
  };
}

function buildSyncedSummary(input: ExplainConnectorSyncInput, nowMs: number): string {
  const relative = formatRelative(input.lastSyncFinishedAt, nowMs);
  const counts = countsSummary(input.providerType, input.lastSyncCounts);
  return counts ? `Last run ${relative}: ${counts}.` : `Last run ${relative}.`;
}

function countsSummary(
  providerType: ConnectorProviderType,
  counts: ConnectorSyncCounts | null
): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (providerType === "google" && counts.calendarUpserted !== undefined) {
    parts.push(pluralize(counts.calendarUpserted, "calendar event"));
  }
  if (counts.emailUpserted !== undefined) {
    parts.push(pluralize(counts.emailUpserted, "email"));
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function providerLabel(providerType: ConnectorProviderType): string {
  return providerType === "google" ? "Google" : "The email provider";
}

/**
 * Full sentence for the "reason" field, matching the spec's error-code table. Unknown
 * codes fall back to the code with dashes replaced by spaces, as today.
 */
function errorCodeSentence(error: string | null, counts: ConnectorSyncCounts | null): string | null {
  switch (error) {
    case "auth-error":
      return "The provider rejected the saved sign-in.";
    case "calendar-error":
      return "Calendar could not be read.";
    case "calendar-item-error":
      return "Some calendar events could not be saved.";
    case "email-error":
      return "Mailbox could not be read.";
    case "email-message-error": {
      const n = counts?.emailFailures ?? 0;
      return `${n} message${n === 1 ? "" : "s"} could not be read; usually the provider refused them one at a time.`;
    }
    case "no-active-connection":
      return "There is no active connection for this account.";
    case null:
      return null;
    default:
      return error.replace(/-/g, " ");
  }
}

/** Lowercase clause form of the same table, without a trailing period, for "because <reason>." sentences. */
function errorCodeClause(error: string | null, counts: ConnectorSyncCounts | null): string | null {
  const sentence = errorCodeSentence(error, counts);
  if (!sentence) return null;
  const clause = sentence.endsWith(".") ? sentence.slice(0, -1) : sentence;
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}

function formatRelative(iso: string | null, nowMs: number): string {
  if (!iso) return "recently";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "recently";
  const elapsedMs = Math.max(0, nowMs - then);
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Renders in UTC rather than the server's local clock, so this stays deterministic
 * regardless of where it runs. A future UI layer can localize for the viewer if needed.
 */
function formatClockTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/* ---------------------------------------------------------------------------------- */
/* Capability map and lost-ability notices                                            */
/* ---------------------------------------------------------------------------------- */

/** Which sync phase a capability depends on. */
export type ConnectorCapabilityKind = "calendar" | "email";

export interface ConnectorCapability {
  /** Positive description, for documentation only — never shown to the user as-is. */
  readonly ability: string;
  /** What the not-working line says when this capability is down. */
  readonly notWorkingLabel: string;
  readonly dependsOn: ConnectorCapabilityKind;
  /** True only for the one ability that also needs the assistant's mail-reading step. */
  readonly requiresAiStep: boolean;
  /** How long after the last good phase this capability is still considered current. */
  readonly staleAfterMs: number;
  readonly fix: ConnectorNotWorkingFix;
}

export type ConnectorCapabilityMap = readonly ConnectorCapability[];

export interface ConnectorNotWorkingFix {
  readonly label: string;
  readonly path: string;
}

export interface ConnectorNotWorkingEntry {
  /** What is not working, in Ben's phrasing — e.g. "Cannot create tasks from email". */
  readonly ability: string;
  /** When this capability last worked, or null if it never has. */
  readonly since: string | null;
  readonly reason: string;
  readonly fix: ConnectorNotWorkingFix;
}

export interface ConnectorNotWorkingFacts {
  readonly providerType: ConnectorProviderType;
  readonly accountStatus: ConnectorAccountStatus;
  /** True only for a failed run whose error code is the provider rejecting the sign-in. */
  readonly signInExpired: boolean;
  /** Phases that failed outright on the most recent run (empty for a partial or success run). */
  readonly failedKinds: readonly ConnectorCapabilityKind[];
  readonly lastSyncError: string | null;
  readonly lastSyncCounts: ConnectorSyncCounts | null;
  readonly calendarLastGoodAt: string | null;
  readonly emailLastGoodAt: string | null;
  readonly deferredAi: ConnectorDeferredAi | null;
}

const ASSISTANT_FIX: ConnectorNotWorkingFix = {
  label: "Log the assistant in",
  path: "/settings?section=assistant"
};

/**
 * Turns a capability map and the current run facts into the list of lost abilities to
 * show outside Settings. A failure that takes nothing away — a partial run the next run
 * will retry, a calendar that is stale-but-recent — produces no entry.
 */
export function deriveNotWorking(
  map: ConnectorCapabilityMap,
  facts: ConnectorNotWorkingFacts,
  now: Date
): readonly ConnectorNotWorkingEntry[] {
  if (facts.accountStatus === "revoked") return [];

  if (facts.signInExpired) {
    return map.map((capability) => ({
      ability: capability.notWorkingLabel,
      since: lastGoodFor(capability, facts),
      reason: `${providerLabel(facts.providerType)} no longer accepts the saved sign-in.`,
      fix: capability.fix
    }));
  }

  const nowMs = now.getTime();
  const entries: ConnectorNotWorkingEntry[] = [];

  for (const capability of map) {
    const lastGoodAt = lastGoodFor(capability, facts);
    const failedThisRun = facts.failedKinds.includes(capability.dependsOn);
    const stale = lastGoodAt === null || nowMs - Date.parse(lastGoodAt) > capability.staleAfterMs;

    if (failedThisRun || stale) {
      entries.push({
        ability: capability.notWorkingLabel,
        since: lastGoodAt,
        reason:
          (failedThisRun ? errorCodeClause(facts.lastSyncError, facts.lastSyncCounts) : null) ??
          (failedThisRun ? "the sync has not run" : "the last good sync is too old"),
        fix: capability.fix
      });
      continue;
    }

    if (capability.requiresAiStep && facts.deferredAi) {
      entries.push({
        ability: capability.notWorkingLabel,
        since: lastGoodAt,
        reason: facts.deferredAi.reason,
        fix: ASSISTANT_FIX
      });
    }
  }

  return entries;
}

function lastGoodFor(capability: ConnectorCapability, facts: ConnectorNotWorkingFacts): string | null {
  return capability.dependsOn === "calendar" ? facts.calendarLastGoodAt : facts.emailLastGoodAt;
}
