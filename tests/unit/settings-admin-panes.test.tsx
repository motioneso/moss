import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { HostPane, PeoplePane } from "../../apps/web/src/settings/settings-admin-panes.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

function renderWithQuery(
  node: React.ReactNode,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
): string {
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(FeedbackProvider, null, node))
  );
}

describe("settings admin panes", () => {
  it("shows registration controls in People & access without operator auth copy", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.adminUsers, { users: [] });
    client.setQueryData(queryKeys.settings.registrationSettings, {
      registrationEnabled: true,
      requiresApproval: true
    });
    const html = renderWithQuery(
      createElement(PeoplePane, {
        me: {
          user: {
            id: "u1",
            email: "u@example.test",
            emailVerified: true,
            name: "U",
            status: "active",
            isInstanceAdmin: true,
            isBootstrapOwner: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          },
          profilePrefs: { addressed: null },
          hasPasswordCredential: true
        },
        onNavigate: () => undefined
      }),
      client
    );

    expect(html).toContain("People &amp; access");
    expect(html).toContain("Registration");
    expect(html).toContain("Allow new registrations");
    expect(html).not.toContain("Auth provider configuration");
  });

  it("shows herdr availability as a status badge, with an install action when not installed", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: true, herdr: false },
      herdrInstalled: false,
      active: "tmux",
      activeSource: "auto",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).toContain("tmux available");
    expect(html).toContain("herdr available");
    expect(html).toContain("Install Herdr");
  });

  it("has no deployment mode, restart-command copy rows, or restart action", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: true, herdr: true },
      herdrInstalled: true,
      active: "herdr",
      activeSource: "auto",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).not.toContain("Deployment mode");
    expect(html).not.toContain("Restart command");
    expect(html).not.toContain("Operator-managed");
    expect(html).not.toContain("Restart API");
  });

  it("shows the Install Herdr row when herdr is not installed", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: true, herdr: false },
      herdrInstalled: false,
      active: "tmux",
      activeSource: "auto",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).toContain("Install Herdr");
    expect(html).toContain("Not installed on this host.");
  });

  it("does not show the Install Herdr row once herdr is installed", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: true, herdr: true },
      herdrInstalled: true,
      active: "herdr",
      activeSource: "auto",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).not.toContain("Install Herdr");
  });

  it("does not render an unusable browser attach hint when herdr is the active mux", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "herdr",
      available: { tmux: false, herdr: true },
      herdrInstalled: true,
      active: "herdr",
      activeSource: "configured",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).not.toContain("herdr pane list");
    expect(html).not.toContain("herdr pane attach");
  });

  it("shows an env-override note when JARVIS_MULTIPLEXER pins the active mux", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "herdr",
      available: { tmux: true, herdr: true },
      herdrInstalled: true,
      active: "tmux",
      activeSource: "env",
      envOverride: "tmux"
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).toContain("JARVIS_MULTIPLEXER");
    expect(html).not.toContain("herdr pane attach");
  });

  it("shows installed-but-not-usable guidance when herdr is installed but has no root pane", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: true, herdr: false },
      herdrInstalled: true,
      active: "tmux",
      activeSource: "auto",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).toContain("JARVIS_HERDR_ROOT_PANE");
  });

  it("shows BOTH the tmux attach commands and the herdr-broken hint when tmux is active and herdr is installed-but-broken", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: true, herdr: false },
      herdrInstalled: true,
      active: "tmux",
      activeSource: "auto",
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    // the operator still needs the working tmux attach command...
    expect(html).toContain("docker compose exec jarv1s tmux attach");
    // ...AND the note that herdr is present but not yet usable.
    expect(html).toContain("JARVIS_HERDR_ROOT_PANE");
  });

  it("shows a distinct not-usable note (no tmux/herdr attach commands) when nothing is usable", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.chatMultiplexer, {
      multiplexer: "auto",
      available: { tmux: false, herdr: false },
      herdrInstalled: false,
      active: null,
      activeSource: null,
      envOverride: null
    });

    const html = renderWithQuery(createElement(HostPane), client);

    expect(html).not.toContain("docker compose exec jarv1s tmux");
    expect(html).not.toContain("herdr pane attach");
    expect(html).toContain("No chat multiplexer is usable");
  });
});
