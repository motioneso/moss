import { describe, expect, it } from "vitest";

import {
  searchSettings,
  type SettingsSearchItem
} from "../../apps/web/src/settings/settings-search.js";

const items: readonly SettingsSearchItem[] = [
  {
    id: "profile",
    label: "Account & preferences",
    description: "Edit personal profile, account, and preference details.",
    group: "Your account",
    keywords: ["time zone", "weather", "fahrenheit", "quiet hours"]
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Choose the app theme and palette.",
    group: "Your account",
    keywords: ["theme", "dark mode"]
  },
  {
    id: "aiproviders",
    label: "AI providers",
    description: "Connect the models the assistant can use.",
    group: "Setup",
    keywords: ["api key", "anthropic"]
  }
];

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings(items, "   ")).toEqual([]);
  });

  it("finds a section by a keyword the label does not carry", () => {
    expect(searchSettings(items, "fahrenheit").map((item) => item.id)).toEqual(["profile"]);
    expect(searchSettings(items, "dark").map((item) => item.id)).toEqual(["appearance"]);
  });

  it("ranks a label hit above a description hit and requires every word", () => {
    // "ai" is in the AI providers label and inside "details" in the profile description.
    expect(searchSettings(items, "ai").map((item) => item.id)).toEqual(["aiproviders", "profile"]);
    expect(searchSettings(items, "app").map((item) => item.id)).toEqual(["appearance"]);
    expect(searchSettings(items, "theme weather")).toEqual([]);
  });

  it("caps the result count", () => {
    expect(searchSettings(items, "a", 2)).toHaveLength(2);
  });
});
