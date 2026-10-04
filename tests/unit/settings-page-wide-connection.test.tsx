import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SettingsPage } from "../../apps/web/src/settings/settings-page.js";

// One open connection takes the full width of Settings (#2984 R2.5).

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss"
}));

vi.mock("virtual:moss-module-settings", () => ({
  MODULE_SETTINGS_SURFACES: [],
  MODULE_SETTINGS_COMPONENTS: {},
  MODULE_SETTING_KEYWORDS: {}
}));

const me = {
  user: {
    id: "user-1",
    email: "user@example.test",
    emailVerified: true,
    name: "User",
    status: "active" as const,
    isInstanceAdmin: false,
    isBootstrapOwner: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: false
};

function render(path: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsPage me={me} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function shellClass(html: string): string {
  return /<div class="(set2[^"]*)"/.exec(html)?.[1] ?? "";
}

describe("Settings shell with one connection open", () => {
  it("drops the section list while a connection is open", () => {
    expect(shellClass(render("/settings?section=connections&integration=conn-1"))).toContain(
      "set2--wide"
    );
  });

  it("keeps the section list on Connections itself and while adding a connection", () => {
    expect(shellClass(render("/settings?section=connections"))).not.toContain("set2--wide");
    expect(shellClass(render("/settings?section=connections&integration=new"))).not.toContain(
      "set2--wide"
    );
  });
});
