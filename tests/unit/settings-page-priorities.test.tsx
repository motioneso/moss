import { describe, expect, it, vi } from "vitest";
import { renderToPipeableStream, renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { Writable } from "node:stream";
import type { ReactNode } from "react";

import { SettingsPage } from "../../apps/web/src/settings/settings-page.js";
import { CORE_APP_SETTINGS } from "../../packages/shared/src/app-map-core.js";

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss"
}));

function renderAll(element: ReactNode): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        html += chunk.toString();
        callback();
      }
    });
    destination.on("finish", () => resolve(html));
    const { pipe } = renderToPipeableStream(element, {
      onAllReady: () => pipe(destination),
      onError: reject
    });
  });
}

describe("SettingsPage priorities navigation", () => {
  const nonAdminMe = {
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
  const adminMe = {
    user: {
      id: "admin-1",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
      status: "active" as const,
      isInstanceAdmin: true,
      isBootstrapOwner: true,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  };

  it("exposes Priorities in personal settings navigation", () => {
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage me={nonAdminMe} />
      </MemoryRouter>
    );

    expect(html).toContain("Moss");
    expect(html).toContain("Priorities");
  });

  it("does not render the global Advanced settings toggle", () => {
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage me={adminMe} />
      </MemoryRouter>
    );

    expect(html).toContain("Admin / Setup");
    expect(html).not.toContain("Advanced settings");
    expect(html).not.toContain("Show provider, host &amp; developer detail");
  });

  it("renders the four personal group labels and drops merged destinations", () => {
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage me={nonAdminMe} />
      </MemoryRouter>
    );

    expect(html).toContain("Your account");
    expect(html).toContain("Moss");
    expect(html).toContain("Connections");
    expect(html).toContain("Extensions");
    expect(html).toContain("Account &amp; preferences");
    expect(html).not.toContain(">General<");
  });

  it("renders the three admin group labels and drops the Identity destination", () => {
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings?section=people"]}>
        <SettingsPage me={adminMe} />
      </MemoryRouter>
    );

    expect(html).toContain("Access");
    expect(html).toContain("AI &amp; extensions");
    expect(html).toContain("Operations");
    expect(html).not.toContain("Identity &amp; registration");
  });

  it("falls back to a permitted personal section for a non-admin admin deep link", () => {
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings?section=people"]}>
        <SettingsPage me={nonAdminMe} />
      </MemoryRouter>
    );

    expect(html).toContain("Account &amp; preferences");
    expect(html).not.toContain("People &amp; access");
  });

  it("renders Recently Released as the active Moss destination for a non-admin", async () => {
    const html = await renderAll(
      <MemoryRouter initialEntries={["/settings?section=released"]}>
        <SettingsPage me={nonAdminMe} />
      </MemoryRouter>
    );
    expect(html).toContain("Moss");
    expect(html).toContain("Recently Released");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Guided Job Search onboarding");
  });

  it("declares Recently Released in the core app map", () => {
    expect(CORE_APP_SETTINGS).toContainEqual({
      id: "released",
      label: "Recently Released",
      description: "See what was added, fixed, and changed in recent Moss releases.",
      path: "/settings?section=released",
      scope: "user"
    });
  });
});
