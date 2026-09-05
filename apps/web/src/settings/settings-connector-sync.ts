import { explainConnectorSync } from "@moss/shared";
import type { ConnectorAccountDto, ConnectorSyncCounts } from "@moss/shared";

/**
 * Thin adapter over the shared `explainConnectorSync` wording. This file only maps that
 * shared explanation onto the exact strings this settings pane has always shown — the
 * words themselves live in `packages/shared/src/connector-sync-explain.ts`.
 */

export type ConnectorAccountHealth = {
  readonly indicator: "ready" | "error" | "idle";
  readonly badgeTone: "forest" | "amber" | "neutral";
  readonly label: string;
  readonly alert: string | null;
  readonly canReconnect: boolean;
};

export function isConnectorSyncInFlight(
  account: Pick<ConnectorAccountDto, "lastSyncStartedAt" | "lastSyncFinishedAt">
): boolean {
  const startedAt = parseTimestamp(account.lastSyncStartedAt);
  if (startedAt === null) return false;
  const finishedAt = parseTimestamp(account.lastSyncFinishedAt);
  return finishedAt === null || finishedAt < startedAt;
}

export function getConnectorAccountHealth(
  account: Pick<
    ConnectorAccountDto,
    | "providerType"
    | "status"
    | "lastSyncStartedAt"
    | "lastSyncFinishedAt"
    | "lastSyncStatus"
    | "lastSyncError"
    | "lastSyncCounts"
  >
): ConnectorAccountHealth {
  if (account.status === "revoked") {
    return {
      indicator: "idle",
      badgeTone: "neutral",
      label: "Revoked",
      alert: null,
      canReconnect: false
    };
  }

  if (isConnectorSyncInFlight(account)) {
    return {
      indicator: "idle",
      badgeTone: "neutral",
      label: "Syncing",
      alert: null,
      canReconnect: false
    };
  }

  const explained = explainConnectorSync(
    {
      providerType: account.providerType,
      status: account.status,
      lastSyncStartedAt: account.lastSyncStartedAt,
      lastSyncFinishedAt: account.lastSyncFinishedAt,
      lastSyncStatus: account.lastSyncStatus,
      lastSyncError: account.lastSyncError,
      lastSyncCounts: account.lastSyncCounts,
      pending: null,
      nextRunAt: null,
      deferredAi: null
    },
    new Date()
  );

  switch (explained.code) {
    case "sign-in-expired":
      return {
        indicator: "error",
        badgeTone: "amber",
        label: "Sign-in expired",
        alert: `Last sync failed because ${account.providerType === "google" ? "Google" : "email"} access needs to be reconnected. Reconnect to resume syncing.`,
        canReconnect: true
      };

    case "connection-error":
      // Two different situations both land here: a failed run with a non-auth error, or
      // the account itself reporting a connection problem outside of a run.
      if (account.lastSyncStatus === "failed") {
        return {
          indicator: "error",
          badgeTone: "amber",
          label: "Sign-in expired",
          alert: syncAlert("Last sync failed", account.lastSyncError, account.lastSyncCounts),
          canReconnect: account.providerType === "google"
        };
      }
      return {
        indicator: "error",
        badgeTone: "amber",
        label: "Connection error",
        alert:
          account.providerType === "google"
            ? "Google reported a connection error. Reconnect to restore syncing."
            : "This email account reported a connection error. Reconnect to restore syncing.",
        canReconnect: true
      };

    case "capped":
      return {
        indicator: "error",
        badgeTone: "amber",
        label: "Message cap reached",
        alert: syncAlert(
          "Last sync reached its message cap",
          account.lastSyncError,
          account.lastSyncCounts
        ),
        canReconnect: false
      };

    case "partial":
      return {
        indicator: "error",
        badgeTone: "amber",
        label: "Partial sync",
        alert: syncAlert(
          "Last sync completed with errors",
          account.lastSyncError,
          account.lastSyncCounts
        ),
        canReconnect: false
      };

    case "not-scheduled":
    case "first-run-pending":
      return {
        indicator: "idle",
        badgeTone: "neutral",
        label: "Awaiting first sync",
        alert: "First sync hasn't run yet — new data will appear once it completes.",
        canReconnect: false
      };

    default:
      return {
        indicator: "ready",
        badgeTone: "forest",
        label: "Synced",
        alert: null,
        canReconnect: false
      };
  }
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function syncAlert(
  prefix: string,
  error: string | null,
  counts: ConnectorSyncCounts | null
): string {
  const details = [syncErrorLabel(error), syncCountsLabel(counts)].filter(Boolean).join(" · ");
  return details
    ? `${prefix}: ${details}. Cached Google data may be stale.`
    : `${prefix}. Cached Google data may be stale.`;
}

function syncErrorLabel(error: string | null): string | null {
  switch (error) {
    case "calendar-error":
      return "Calendar sync failed";
    case "calendar-item-error":
      return "Some calendar items could not be saved";
    case "email-error":
      return "Email sync failed";
    case "email-message-error":
      return "Some email messages could not be saved";
    case "no-active-connection":
      return "No active Google connection";
    case null:
      return null;
    default:
      return error.replace(/-/g, " ");
  }
}

function syncCountsLabel(counts: ConnectorSyncCounts | null): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.emailFailures) {
    parts.push(
      `${counts.emailFailures} email message${counts.emailFailures === 1 ? "" : "s"} failed`
    );
  }
  if (counts.truncated) parts.push("message cap reached");
  return parts.length > 0 ? parts.join(", ") : null;
}
