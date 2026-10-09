import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { defaultProactiveMonitoringPreference } from "@moss/shared";

describe("AlertsPane", () => {
  it("keeps automatic email alerts separate from delivery and quiet-hours controls", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { queryKeys } = await import("../../apps/web/src/api/query-keys.js");
    client.setQueryData(queryKeys.proactiveMonitoring.settings, {
      settings: { ...defaultProactiveMonitoringPreference(), automaticEmailAlerts: true }
    });
    client.setQueryData(queryKeys.connectors.accounts, { accounts: [] });
    const { AlertsPane } = await import("../../apps/web/src/settings/settings-alerts-pane.js");

    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AlertsPane, {
          me: {} as never,
          onNavigate: () => {},
          onSelectSection: () => {}
        }) as ReactElement
      )
    );

    expect(html).toContain("Automatic email alerts");
    expect(html).toContain(
      "Turning this off never changes email access, requested work, or other sources."
    );
    expect(html).toContain("Notifications and email digest");
    expect(html).toContain("Quiet hours");
    expect(html).toContain(
      "No email can be checked until a connected account is active and permitted."
    );
  });
});
