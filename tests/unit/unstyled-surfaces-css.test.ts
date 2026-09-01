import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = [
  "apps/web/src/styles/kit-chat.css",
  "apps/web/src/styles/onboarding-design.css",
  "apps/web/src/styles/settings-panes-2.css",
  "apps/web/src/styles/settings-panes-3.css"
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

describe("#686 unstyled surface CSS", () => {
  it("styles chat source, memory, onboarding auth, and activity classes", () => {
    for (const selector of [
      ".source-chips",
      ".source-chip",
      ".source-tray",
      ".onb-auth__paste",
      ".onb-auth__code",
      ".audfilter",
      ".aud__row"
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("styles the integrations settings pane (#2162)", () => {
    for (const selector of [
      ".intg__name",
      ".intg__status",
      ".intg__controls",
      ".intg__form",
      ".intg__acts",
      ".intg__spec-link"
    ]) {
      expect(css).toContain(selector);
    }
  });
});
