import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { integrationsModuleManifest } from "../../packages/integrations/src/manifest.js";
import { CORE_APP_SETTINGS } from "../../packages/shared/src/app-map-core.js";

// #2984 R2.5b review: the app map must name every state the Classifier panel can show, and the
// panel's spacing must meet the design system's minimum gaps.

const connections = CORE_APP_SETTINGS.find((entry) => entry.id === "connections");
const panelFeature = integrationsModuleManifest.features.find(
  (feature) => feature.id === "integrations.connection_classifier_panel"
);

describe("Classifier panel in the app map", () => {
  const states = ["Off", "Preparing", "Ready", "Couldn't prepare", "No tools left", "Paused"];

  it("names every panel state in the Connections setting", () => {
    for (const state of states) expect(connections?.description).toContain(state);
  });

  it("names every panel state in the module feature", () => {
    for (const state of states) expect(panelFeature?.description).toContain(state);
  });

  it("declares each module feature id once", () => {
    const ids = integrationsModuleManifest.features.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers Change default model only for model failures", () => {
    expect(connections?.description).toContain(
      "Change default model, which opens Your assistant, when no model is set"
    );
  });
});

const css = readFileSync("apps/web/src/styles/settings-panes-3.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  return match?.groups?.body ?? "";
}

describe("Classifier panel spacing", () => {
  it("keeps 12px between a control and the text above or below it", () => {
    expect(rule(".intg-clsf__sorting,\n.intg-clsf__foot")).toContain("gap: var(--space-3)");
  });

  it("keeps 8px between a badge icon and its label", () => {
    expect(rule(".intg-tool__meta .jds-badge")).toContain("gap: var(--space-2)");
  });
});
