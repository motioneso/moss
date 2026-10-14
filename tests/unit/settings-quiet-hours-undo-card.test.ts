import { afterEach, describe, expect, it } from "vitest";

import { undoSettingsPresentation } from "../../packages/settings/src/action-presentations.js";
import { settingsUndoStack } from "../../packages/settings/src/undo-stack.js";

const ctx = { actorUserId: "user-a", chatSessionId: "chat-1" } as never;

function push(previousValue: unknown) {
  settingsUndoStack.push("user-a", "chat-1", {
    mutationId: "m-1",
    key: "quiet-hours",
    previousValue,
    previousRevision: 1,
    resultingRevision: 2,
    appliedAt: Date.now()
  });
}

describe("quiet-hours undo approval card", () => {
  afterEach(() => settingsUndoStack.clear("user-a", "chat-1"));

  it("discloses the restored migration state instead of failing the card", async () => {
    push({ enabled: true, start: "22:00", end: "07:00", timezone: null, authority: "unresolved" });
    const card = await undoSettingsPresentation({} as never, {}, ctx, undefined as never);
    expect(card?.target).toBe("Quiet hours");
    expect(card?.fields).toContainEqual({
      label: "Quiet hours source",
      value: "Not settled: alerts keep their own schedule"
    });
  });

  it("shows a settled Profile schedule", async () => {
    push({ enabled: false, start: "21:00", end: "06:00", timezone: null, authority: "canonical" });
    const card = await undoSettingsPresentation({} as never, {}, ctx, undefined as never);
    expect(card?.fields).toContainEqual({ label: "Quiet hours source", value: "Profile" });
  });

  it("still refuses an unknown marker", async () => {
    push({ enabled: false, start: "21:00", end: "06:00", timezone: null, authority: "other" });
    expect(await undoSettingsPresentation({} as never, {}, ctx, undefined as never)).toBeNull();
  });
});
