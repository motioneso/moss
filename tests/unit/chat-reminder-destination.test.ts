import { describe, expect, it } from "vitest";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";
import { recognizeReminderEdit } from "../../packages/chat/src/reminders/edit-recognizer.js";
import { validateReminderEdit } from "../../packages/chat/src/reminders/edit-interpretation.js";

describe("explicit reminder destinations", () => {
  it.each([
    ["remind me in 5 minutes to stretch and send it to the Travel chat", "Travel"],
    ["remind me in 5 minutes to stretch, send the results to Travel", "Travel"],
    ["remind me in 5 minutes to stretch in this chat", "this chat"]
  ])("separates the delivery clause from inert text: %s", (raw, destination) => {
    expect(recognizeReminderPlan(raw)).toEqual({
      kind: "request",
      delaySeconds: 300,
      text: "stretch",
      destination
    });
  });
  it("retains repeat terms while extracting an explicit destination", () => {
    expect(
      recognizeReminderPlan("remind me every 60 seconds to stretch, send it to the Travel chat")
    ).toEqual({
      kind: "repeat_request",
      repeat: { kind: "interval", seconds: 60 },
      clock: null,
      weekday: null,
      text: "stretch",
      destination: "Travel"
    });
  });
  it("does not turn an inert chat mention into routing", () => {
    expect(recognizeReminderPlan("remind me in 5 minutes to read the Travel chat")).toEqual({
      kind: "request",
      delaySeconds: 300,
      text: "read the Travel chat"
    });
  });
  it("routes a destination-only edit", () => {
    expect(recognizeReminderEdit("send my stretch reminder to the Travel chat")).toBe(true);
    expect(recognizeReminderEdit("send this paragraph to the Travel chat")).toBe(false);
  });
  it("accepts a destination name but rejects authority fields", () => {
    const value = {
      target: "stretch",
      unsupported: false,
      text: null,
      delaySeconds: null,
      localDue: null,
      deadline: "keep",
      localDeadline: null,
      destination: "Travel"
    };
    expect(validateReminderEdit(value)).toEqual(value);
    expect(validateReminderEdit({ ...value, ownerUserId: "another owner" })).toBeUndefined();
  });
});
