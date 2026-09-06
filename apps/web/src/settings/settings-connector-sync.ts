import { explainConnectorAccountHealth } from "@moss/shared";
import type {
  ConnectorAccountDto,
  ConnectorSyncExplainCode,
  ConnectorSyncTone
} from "@moss/shared";

/**
 * Display adaptation only. Every user-visible word for a connected account now comes from
 * `packages/shared/src/connector-sync-explain.ts`; this file just turns the shared status
 * code and tone into the indicator dot and badge tone this pane's markup understands.
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
  const health = explainConnectorAccountHealth(
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
      deferredAi: null,
      syncInFlight: isConnectorSyncInFlight(account)
    },
    new Date()
  );

  return {
    indicator: indicatorFor(health.code),
    badgeTone: badgeToneFor(health.tone),
    label: health.label,
    alert: health.alert,
    canReconnect: health.canReconnect
  };
}

/** The coloured dot beside the account name. */
function indicatorFor(code: ConnectorSyncExplainCode): ConnectorAccountHealth["indicator"] {
  switch (code) {
    case "sign-in-expired":
    case "connection-error":
    case "capped":
    case "partial":
    case "waiting-for-worker":
      return "error";
    case "revoked":
    case "syncing":
    case "queued":
    case "first-run-pending":
    case "not-scheduled":
      return "idle";
    default:
      return "ready";
  }
}

/** This pane's badge has no red, so a shared red reads as amber here. */
function badgeToneFor(tone: ConnectorSyncTone): ConnectorAccountHealth["badgeTone"] {
  switch (tone) {
    case "forest":
      return "forest";
    case "amber":
    case "red":
      return "amber";
    default:
      return "neutral";
  }
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
