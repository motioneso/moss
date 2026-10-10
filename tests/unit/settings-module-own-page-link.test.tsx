import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ModuleOwnPageLink } from "../../apps/web/src/settings/settings-module-own-page-link.js";

describe("host Settings entry for a module with its own settings page (#3184)", () => {
  it("shows one link to the module page and no credential or switch content", () => {
    const html = renderToString(
      createElement(ModuleOwnPageLink, {
        moduleName: "Ledger",
        settingsPath: "/m/ledger/settings",
        onBack: vi.fn(),
        onNavigate: vi.fn()
      })
    );
    expect(html).toContain('aria-label="Open Ledger settings"');
    expect(html).not.toContain("credential");
    expect(html).not.toContain('role="switch"');
  });
});
