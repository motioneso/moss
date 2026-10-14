import { describe, expect, it } from "vitest";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";

describe("typed reminder controls", () => {
  it("recognizes pause and resume without changing explicit cancel", () => {
    expect(recognizeReminderPlan("pause my reminder to stretch")).toEqual({
      kind: "pause",
      target: "stretch"
    });
    expect(recognizeReminderPlan("resume my stretch reminder")).toEqual({
      kind: "resume",
      target: "stretch"
    });
    expect(recognizeReminderPlan("cancel my reminder to stretch")).toEqual({
      kind: "cancel",
      target: "stretch"
    });
  });
  it("requests deletion rather than cancelling immediately", () => {
    expect(recognizeReminderPlan("delete my reminder to stretch")).toEqual({
      kind: "delete",
      target: "stretch"
    });
    expect(recognizeReminderPlan("remove my stretch reminder")).toEqual({
      kind: "delete",
      target: "stretch"
    });
    expect(recognizeReminderPlan("yes")).toEqual({ kind: "quiet_agreement", agree: true });
  });
});
