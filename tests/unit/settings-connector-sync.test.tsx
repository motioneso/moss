import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  getConnectorAccountHealth,
  isConnectorSyncInFlight
} from "../../apps/web/src/settings/settings-connector-sync.js";

import type { ConnectorAccountDto } from "@moss/shared";

vi.mock("virtual:moss-module-settings", () => ({
  MODULE_SETTINGS_SURFACES: [],
  MODULE_SETTINGS_COMPONENTS: {}
}));
type HealthAccount = Parameters<typeof getConnectorAccountHealth>[0];

const baseAccount: HealthAccount = {
  providerType: "google",
  status: "active",
  lastSyncStartedAt: "2026-06-30T12:00:00.000Z",
  lastSyncFinishedAt: "2026-06-30T12:00:05.000Z",
  lastSyncStatus: "success",
  lastSyncError: null,
  lastSyncCounts: null
};

describe("connector sync account health", () => {
  it("treats a failed Gmail sync as loud needs-attention with a reconnect CTA", () => {
    const health = getConnectorAccountHealth({
      ...baseAccount,
      lastSyncStatus: "failed",
      lastSyncError: "auth-error"
    });

    expect(health).toMatchObject({
      indicator: "error",
      badgeTone: "amber",
      label: "Sign-in expired",
      canReconnect: true
    });
    expect(health.alert).toContain("Google access needs to be reconnected");
  });

  it("keeps partial syncs visible without sending users through reconnect", () => {
    const health = getConnectorAccountHealth({
      ...baseAccount,
      lastSyncStatus: "partial",
      lastSyncError: "email-message-error",
      lastSyncCounts: { emailFailures: 2 }
    });

    expect(health).toMatchObject({
      indicator: "error",
      badgeTone: "amber",
      label: "Partial sync",
      canReconnect: false
    });
    expect(health.alert).toContain("Some email messages could not be saved");
    expect(health.alert).toContain("2 email messages failed");
    expect(health.alert).toContain("Cached Google data may be stale");
  });

  it("explains message-cap partial syncs without inventing an item error", () => {
    const health = getConnectorAccountHealth({
      ...baseAccount,
      lastSyncStatus: "partial",
      lastSyncError: null,
      lastSyncCounts: { emailUpserted: 50, calendarUpserted: 18, emailFailures: 0, truncated: true }
    });

    expect(health).toMatchObject({
      indicator: "error",
      badgeTone: "amber",
      label: "Message cap reached"
    });
    expect(health.alert).toContain("Last sync reached its message cap");
    expect(health.alert).toContain("message cap reached");
    expect(health.alert).toContain("Cached Google data may be stale");
  });

  it("keeps polling while a started sync has not finished", () => {
    const account = {
      ...baseAccount,
      lastSyncStartedAt: "2026-06-30T12:01:00.000Z",
      lastSyncFinishedAt: "2026-06-30T12:00:05.000Z",
      lastSyncStatus: null
    };

    expect(isConnectorSyncInFlight(account)).toBe(true);
    expect(getConnectorAccountHealth(account)).toMatchObject({
      indicator: "idle",
      badgeTone: "neutral",
      label: "Syncing"
    });
  });

  it("shows a fresh sync in progress instead of stale partial status", () => {
    const account = {
      ...baseAccount,
      lastSyncStartedAt: "2026-06-30T12:01:00.000Z",
      lastSyncFinishedAt: "2026-06-30T12:00:05.000Z",
      lastSyncStatus: "partial" as const,
      lastSyncError: "email-message-error"
    };

    expect(getConnectorAccountHealth(account)).toMatchObject({
      indicator: "idle",
      badgeTone: "neutral",
      label: "Syncing",
      alert: null
    });
  });

  it("lets revocation win over stale sync metadata", () => {
    const health = getConnectorAccountHealth({
      ...baseAccount,
      status: "revoked",
      lastSyncStatus: "failed",
      lastSyncError: "auth-error"
    });

    expect(health).toMatchObject({
      indicator: "idle",
      badgeTone: "neutral",
      label: "Revoked",
      canReconnect: false
    });
  });
});

const connectedAccount: ConnectorAccountDto = {
  id: "acct-1",
  providerId: "google-email",
  providerType: "google",
  providerDisplayName: "Google (Gmail + Calendar)",
  providerStatus: "available",
  ownerUserId: "user-1",
  scopes: ["gmail.readonly"],
  status: "active",
  hasSecret: true,
  revokedAt: null,
  createdAt: "2026-06-30T11:00:00.000Z",
  updatedAt: "2026-06-30T12:00:05.000Z",
  lastSyncStartedAt: "2026-06-30T12:00:00.000Z",
  lastSyncFinishedAt: "2026-06-30T12:00:05.000Z",
  lastSyncStatus: "success",
  lastSyncError: null,
  lastSyncCounts: null
};

async function renderPane(
  Pane: () => ReactElement | null,
  seed: (client: QueryClient) => void
): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  const { FeedbackProvider } = await import("../../apps/web/src/settings/settings-feedback.js");
  return renderToString(
    createElement(
      FeedbackProvider,
      null,
      createElement(QueryClientProvider, { client }, createElement(Pane))
    )
  );
}

describe("connector settings panes without manual sync (spec #729 §7)", () => {
  it("ConnectedPane shows live health without redundant cache copy or Sync now", async () => {
    const { queryKeys } = await import("../../apps/web/src/api/query-keys.js");
    const { ConnectedPane } =
      await import("../../apps/web/src/settings/settings-personal-data-panes.js");

    const html = await renderPane(ConnectedPane, (client) => {
      client.setQueryData(queryKeys.connectors.accounts, { accounts: [connectedAccount] });
    });

    expect(html).not.toContain("Sync now");
    expect(html).toContain("Live connection");
    expect(html).not.toContain("Fallback cache");
  });

  it("admin OversightPane shows fallback-cache metadata with no Sync now button", async () => {
    const { queryKeys } = await import("../../apps/web/src/api/query-keys.js");
    const { OversightPane } = await import("../../apps/web/src/settings/settings-admin-panes.js");

    const html = await renderPane(OversightPane, (client) => {
      client.setQueryData(queryKeys.settings.adminConnectorAccounts, {
        accounts: [connectedAccount]
      });
    });

    expect(html).not.toContain("Sync now");
    expect(html).toContain("Fallback cache");
  });
});
