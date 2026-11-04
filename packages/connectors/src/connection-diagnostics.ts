import { assertDataContextDb, type DataContextDb } from "@moss/db";
import {
  DIAGNOSTIC_LABEL_MAX,
  type ConnectionObservation,
  type ConnectionsSection
} from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { OUTLOOK_BROWSER_PROVIDER } from "./outlook-calendar-config.js";
import {
  outlookHealthKey,
  readOutlookHealth,
  type OutlookCalendarHealth
} from "./outlook-calendar-jobs.js";
import { ConnectorsRepository, type ConnectorAccountSafeRow } from "./repository.js";

export interface ConnectionDiagnosticsDependencies {
  readonly repository?: Pick<ConnectorsRepository, "listAccounts">;
  readonly preferences?: Pick<PreferencesRepository, "get">;
}

const KNOWN_ERROR_CODES = new Set([
  "auth-error",
  "no-active-connection",
  "disconnected",
  "rate-limited",
  "network-error"
]);

/**
 * Maps a stored sync error to a fixed word. The stored text can carry provider messages, so it
 * is never returned. Unrecognised text becomes "sync-error".
 */
export function connectionErrorLabel(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (KNOWN_ERROR_CODES.has(text)) return text;
  if (/\b(401|403)\b|unauthori[sz]ed|invalid_grant|auth|forbidden|sign.?in/.test(text)) {
    return "auth-error";
  }
  if (/\b429\b|rate.?limit|quota/.test(text)) return "rate-limited";
  if (/timeout|timed out|econn|enotfound|ehostunreach|network|socket|unreachable/.test(text)) {
    return "network-error";
  }
  return "sync-error";
}

function outlookLabels(health: OutlookCalendarHealth): { status: string; error: string | null } {
  switch (health.state) {
    case "partial":
      // The stored state cannot tell an incomplete scan from an unreachable helper.
      return (health.failures ?? 0) > 0
        ? { status: "partial", error: "scan-incomplete-or-helper-unreachable" }
        : { status: "partial", error: "scan-incomplete" };
    case "sign-in-needed":
      return { status: "sign-in-needed", error: "sign-in-needed" };
    case "source-changed":
      return { status: "source-changed", error: "source-changed" };
    case "settings-not-found":
      return { status: "settings-not-found", error: "settings-not-found" };
    case "disconnected":
      return { status: "disconnected", error: "disconnected" };
    case "stale":
      return { status: "stale", error: "stale" };
    case "collecting":
      return { status: "collecting", error: null };
    default:
      return { status: "healthy", error: null };
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function observe(
  account: ConnectorAccountSafeRow,
  outlook: OutlookCalendarHealth | null
): ConnectionObservation {
  const base = {
    provider: account.provider_id.slice(0, DIAGNOSTIC_LABEL_MAX),
    accountId: account.id.slice(0, DIAGNOSTIC_LABEL_MAX)
  };
  if (account.revoked_at !== null || account.status === "revoked") {
    return {
      ...base,
      status: "revoked",
      lastAttemptAt: iso(account.last_sync_started_at),
      lastGoodAt: null,
      failureCount: 0,
      errorLabel: "revoked"
    };
  }
  if (outlook && account.status === "active") {
    const labels = outlookLabels(outlook);
    return {
      ...base,
      status: labels.status,
      lastAttemptAt: iso(outlook.attemptedAt) ?? iso(account.last_sync_started_at),
      lastGoodAt: iso(outlook.lastCompleteAt),
      failureCount: outlook.failures ?? 0,
      errorLabel: labels.error
    };
  }
  const failed = account.last_sync_status === "failed";
  const previous = account.previous_sync ?? null;
  const status =
    account.status === "error"
      ? "error"
      : account.last_sync_status === null
        ? "never-synced"
        : account.last_sync_status === "success"
          ? "healthy"
          : account.last_sync_status === "partial"
            ? "sync-partial"
            : "sync-failed";
  return {
    ...base,
    status,
    lastAttemptAt: iso(account.last_sync_started_at) ?? iso(account.last_sync_finished_at),
    lastGoodAt:
      account.last_sync_status === "success"
        ? iso(account.last_sync_finished_at)
        : previous?.status === "success"
          ? iso(previous.finishedAt)
          : null,
    failureCount: failed ? 1 : 0,
    errorLabel:
      connectionErrorLabel(account.last_sync_error) ??
      (failed || account.status === "error" ? "sync-error" : null)
  };
}

/**
 * Reads the caller's own connections through the connectors repository, so row-level security
 * scopes the list. Errors are returned as fixed labels, never as stored text.
 */
export async function readConnectionDiagnostics(
  scopedDb: DataContextDb,
  options: { readonly limit: number },
  dependencies: ConnectionDiagnosticsDependencies = {}
): Promise<ConnectionsSection> {
  assertDataContextDb(scopedDb);
  const limit = Math.max(1, Math.min(10, Math.floor(options.limit)));
  const repository = dependencies.repository ?? new ConnectorsRepository();
  const preferences = dependencies.preferences ?? new PreferencesRepository();
  const accounts = await repository.listAccounts(scopedDb);
  const items: ConnectionObservation[] = [];
  for (const account of accounts.slice(0, limit)) {
    const outlook =
      account.provider_id === OUTLOOK_BROWSER_PROVIDER
        ? readOutlookHealth(await preferences.get(scopedDb, outlookHealthKey(account.id)))
        : null;
    items.push(observe(account, outlook));
  }
  return { items, truncated: accounts.length > limit };
}
