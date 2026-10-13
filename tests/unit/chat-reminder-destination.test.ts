import { describe, expect, it } from "vitest";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";
import {
  recognizeReminderEdit,
  recognizeReminderDestinationEdit
} from "../../packages/chat/src/reminders/edit-recognizer.js";
import { validateReminderEdit } from "../../packages/chat/src/reminders/edit-interpretation.js";

describe("explicit reminder destinations", () => {
  it.each([
    ["remind me in 5 minutes to stretch and send it to the Travel chat", "Travel"],
    ["remind me in 5 minutes to stretch, send the results to Travel", "Travel"],
    ["remind me in 5 minutes to stretch in this chat", "this chat"],
    ["remind me in 5 minutes to stretch, send it to this chat", "this chat"]
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

describe("explicit destination-only edits", () => {
  it.each([
    ["send my stretch reminder to the Travel chat", "stretch", "Travel"],
    ["deliver the check eyes task results to Main", "check eyes", "Main"],
    ["post my stretch reminder in this chat", "stretch", "this chat"]
  ])("extracts the named pending task and destination: %s", (raw, target, destination) => {
    expect(recognizeReminderDestinationEdit(raw)).toEqual({ target, destination });
  });
  it.each([
    "send this paragraph to the Travel chat",
    "I send my stretch reminder to Main every day",
    "what happens if I send my stretch reminder to Main?",
    "send my reminder to Main",
    "send my reminder app subscription to Main",
    "send my stretch reminder to Travel and change its text to bring water",
    "change my stretch reminder text to bring water and send it to Travel",
    "send my stretch reminder to Main tomorrow at 9am",
    "send my stretch reminder to Travel with text changed to bring water",
    "x".repeat(701)
  ])("leaves ordinary sentences and combined edits unchanged: %s", (raw) => {
    expect(recognizeReminderDestinationEdit(raw)).toBeUndefined();
  });
});

import { matchOwnedReminderDestinations } from "../../packages/chat/src/reminders/destination.js";

const travel = {
  id: "owned",
  owner_user_id: "owner",
  surface: "drawer",
  incognito: false,
  title: "Travel proof"
};
describe("owned destination name matching", () => {
  it.each([
    "the Travel proof chat",
    "travel proof",
    "Travel proof conversation",
    "  THE   travel  proof   CHAT  "
  ])("accepts owner wording %j", (name) => {
    expect(matchOwnedReminderDestinations([travel], "owner", name)).toEqual([travel]);
  });
  it("keeps equivalent owned names ambiguous", () => {
    const other = { ...travel, id: "second", title: "the Travel proof conversation" };
    expect(matchOwnedReminderDestinations([travel, other], "owner", "Travel proof chat")).toEqual([
      travel,
      other
    ]);
  });
  it("never matches a foreign, incognito or other-surface chat", () => {
    expect(
      matchOwnedReminderDestinations(
        [
          { ...travel, owner_user_id: "foreign" },
          { ...travel, incognito: true },
          { ...travel, surface: "meeting" }
        ],
        "owner",
        "the Travel proof chat"
      )
    ).toEqual([]);
    expect(matchOwnedReminderDestinations([travel], "owner", "missing chat")).toEqual([]);
  });
});
