// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  ASSISTANT_NAME_STORAGE_KEY,
  assistantName,
  personalize,
  rememberAssistantName
} from "../../apps/web/src/api/use-assistant-name.js";
import { WelcomeStep } from "../../apps/web/src/onboarding/welcome-step.js";

afterEach(() => {
  rememberAssistantName(null);
  localStorage.clear();
});

describe("assistant name store", () => {
  it("falls back to Moss when no name was ever saved", () => {
    expect(assistantName()).toBe("Moss");
    expect(personalize("Moss is ready.")).toBe("Moss is ready.");
  });

  it("saves a loaded name in the browser and sets the tab title", () => {
    rememberAssistantName("Juniper");

    expect(assistantName()).toBe("Juniper");
    expect(localStorage.getItem(ASSISTANT_NAME_STORAGE_KEY)).toBe("Juniper");
    expect(document.title).toBe("Juniper");
  });

  it("returns to the default and clears the saved name when the name is emptied", () => {
    rememberAssistantName("Juniper");
    rememberAssistantName("  ");

    expect(assistantName()).toBe("Moss");
    expect(localStorage.getItem(ASSISTANT_NAME_STORAGE_KEY)).toBeNull();
  });

  it("replaces only the whole word Moss in fixed copy", () => {
    rememberAssistantName("Juniper");

    expect(personalize("Moss / Morning briefing")).toBe("Juniper / Morning briefing");
    expect(personalize("Moss-planned task and Mossy")).toBe("Juniper-planned task and Mossy");
  });
});

describe("screens use the assistant name", () => {
  it("shows the chosen name on the onboarding welcome step", () => {
    rememberAssistantName("Juniper");
    const html = renderToStaticMarkup(createElement(WelcomeStep, { onSkipAll: () => undefined }));

    expect(html).toContain("Setting up Juniper");
    expect(html).not.toContain("Moss");
  });
});
