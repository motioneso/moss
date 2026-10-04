// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPersonaSettings } from "../../apps/web/src/api/client.js";
import {
  ASSISTANT_NAME_STORAGE_KEY,
  assistantName,
  bindAssistantUser,
  loadPersonaSettings,
  personalize,
  personalizeMarkdown,
  rememberAssistantName
} from "../../apps/web/src/api/use-assistant-name.js";
import { navFieldDesc } from "../../apps/web/src/settings/settings-appearance-pane.js";
import { libraryAction } from "../../apps/web/src/settings/settings-module-registry-section.js";
import { WelcomeStep } from "../../apps/web/src/onboarding/welcome-step.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPersonaSettings: vi.fn()
}));

const persona = (name: string) => ({ persona: { assistantName: name } }) as never;

afterEach(() => {
  bindAssistantUser(null);
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

describe("names stay with their user", () => {
  it("does not carry one user's saved name into another user's signed-in session", () => {
    bindAssistantUser("user-a");
    rememberAssistantName("Juniper");

    bindAssistantUser(null);
    expect(assistantName()).toBe("Juniper");

    bindAssistantUser("user-b");
    expect(assistantName()).toBe("Moss");
    expect(personalize("Moss is ready.")).toBe("Moss is ready.");

    bindAssistantUser("user-a");
    expect(assistantName()).toBe("Juniper");
  });

  it("keeps the default for the second user when their persona fails to load", async () => {
    bindAssistantUser("user-a");
    rememberAssistantName("Juniper");
    bindAssistantUser("user-b");
    vi.mocked(getPersonaSettings).mockRejectedValueOnce(new Error("offline"));

    await expect(loadPersonaSettings()).rejects.toThrow("offline");

    expect(assistantName()).toBe("Moss");
  });

  it("ignores a persona answer that arrives after the user changed", async () => {
    bindAssistantUser("user-a");
    let answer: (value: never) => void = () => undefined;
    vi.mocked(getPersonaSettings).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const pending = loadPersonaSettings();

    bindAssistantUser("user-b");
    answer(persona("Juniper"));
    await pending;

    expect(assistantName()).toBe("Moss");
    expect(localStorage.getItem(ASSISTANT_NAME_STORAGE_KEY)).toBeNull();
  });
});

describe("labels follow a rename", () => {
  it("builds the incompatible-module label from the name at the time it is used", () => {
    const row = { state: "incompatible", requiresCore: "9.0.0" } as never;

    expect(libraryAction(row).label).toBe("Incompatible with this Moss version");
    rememberAssistantName("Birch");
    expect(libraryAction(row).label).toBe("Incompatible with this Birch version");
  });

  it("builds the navigation background hint from the name at the time it is used", () => {
    expect(navFieldDesc()).toContain("the Moss mark");
    rememberAssistantName("Birch");
    expect(navFieldDesc()).toBe("Behind the links, icons and the Birch mark");
  });
});

describe("names with replacement symbols", () => {
  it("shows a name made of dollar tokens literally", () => {
    rememberAssistantName("$&");

    expect(personalize("Moss is ready.")).toBe("$& is ready.");
    expect(personalize("Ask Moss. Moss answers.")).toBe("Ask $&. $& answers.");
  });
});

describe("markdown such as the release notes", () => {
  it("renames prose and headings but leaves code, links and addresses alone", () => {
    const text = [
      "# What's New in Moss",
      "Moss now saves to `Moss/Chats`. [PR](https://github.com/motioneso/moss/pull/1) Moss rocks.",
      "```",
      "Moss stays",
      "```"
    ].join("\n");

    expect(personalizeMarkdown(text, "Juniper")).toBe(
      [
        "# What's New in Juniper",
        "Juniper now saves to `Moss/Chats`. [PR](https://github.com/motioneso/moss/pull/1) Juniper rocks.",
        "```",
        "Moss stays",
        "```"
      ].join("\n")
    );
  });
});
