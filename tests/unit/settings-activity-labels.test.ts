import { describe, expect, it } from "vitest";

import {
  actionLabel,
  moduleLabel,
  outcomeNote
} from "../../apps/web/src/settings/settings-activity-labels.js";

describe("settings activity labels", () => {
  it("does not claim a rate limit or a later retry for a refused call", () => {
    const note = outcomeNote("refused") ?? "";

    expect(note).not.toMatch(/too many|again later|will run|retry/i);
    expect(note).toMatch(/did not run/);
  });

  it("reads a refused command-line tools update as a plain action", () => {
    const entry = {
      toolModuleId: "ai",
      toolName: "cli-tools.update",
      outcome: "refused",
      sourceSurface: "scheduled"
    } as const;

    expect(actionLabel(entry)).toBe("Updated the assistant's command-line tools");
    expect(moduleLabel(entry.toolModuleId)).toBe("Assistant");
  });

  it("names a known tool as a plain action and an unknown one by its module", () => {
    const calendar = {
      toolModuleId: "acp-builtin",
      toolName: "mcp.moss.calendar.listVisibleEvents",
      outcome: "success",
      sourceSurface: "chat"
    } as const;
    expect(actionLabel(calendar)).toBe("Checked your calendar");
    expect(
      actionLabel({ ...calendar, toolName: "newmod.fetchThing", toolModuleId: "newmod" })
    ).toBe("Used Newmod");
  });

  it("gives no note for a successful call", () => {
    expect(outcomeNote("success")).toBeNull();
  });
});
