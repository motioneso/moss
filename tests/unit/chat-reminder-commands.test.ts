import { describe, expect, it } from "vitest";

import { chatModuleManifest } from "../../packages/chat/src/manifest.js";
import { matchTarget, type ReminderList } from "../../packages/chat/src/reminders/cancel.js";
import {
  recognizeReminderCommand,
  recognizeReminderPlan
} from "../../packages/chat/src/reminders/commands.js";
import type { OwnedReminder } from "../../packages/chat/src/reminders/repository.js";
import {
  reminderCancelReply,
  reminderListReply
} from "../../packages/chat/src/reminders/wording.js";

// #3310: list and cancel are recognised only from the user's own words and answered by code.

function reminder(text: string, state: OwnedReminder["state"], dueInSeconds = 600): OwnedReminder {
  return {
    id: `id-${text}`,
    text,
    state,
    contextState: "pending",
    dueAt: new Date(NOW.getTime() + dueInSeconds * 1000),
    createdAt: NOW
  };
}

const NOW = new Date("2026-10-10T12:00:00Z");

describe("recognizing list and cancel", () => {
  it.each([
    "list my reminders",
    "Show me my reminders.",
    "what are my reminders?",
    "what reminders do I have",
    "Hey Moss, do I have any reminders?",
    "please list all my reminders"
  ])("lists for %j", (say) => {
    expect(recognizeReminderCommand(say)).toEqual({ kind: "list" });
  });

  it.each([
    ["cancel the reminder to stretch", "stretch"],
    ["Delete my reminder about the dentist", "the dentist"],
    ["remove that reminder for Mum's call", "mum's call"],
    ["cancel the stretch reminder", "stretch"],
    ["can you cancel my water the plants reminder please", "water the plants"]
  ])("cancels %j with target %j", (say, target) => {
    expect(recognizeReminderCommand(say)).toEqual({ kind: "cancel", target });
  });

  it.each(["cancel my reminder", "cancel my reminders", "delete the reminder"])(
    "cancels %j with no target",
    (say) => {
      expect(recognizeReminderCommand(say)).toEqual({ kind: "cancel", target: null });
    }
  );

  it.each([
    "cancel my meeting",
    "what is a reminder",
    "how do reminders work",
    "I want to cancel the reminder app subscription and get a refund for it",
    "list my notes",
    "x".repeat(701)
  ])("leaves %j to the model", (say) => {
    expect(recognizeReminderCommand(say)).toEqual({ kind: "none" });
  });

  it("prefers a save request over list or cancel", () => {
    expect(recognizeReminderPlan("remind me in 5 minutes to cancel the reminder")).toEqual({
      kind: "request",
      delaySeconds: 300,
      text: "cancel the reminder"
    });
    expect(recognizeReminderPlan("what is the weather")).toBeUndefined();
  });
});

describe("choosing the reminder to cancel", () => {
  const owned = [
    reminder("pay rent", "queued"),
    reminder("pay the phone bill", "queued"),
    reminder("Stretch!", "delivered")
  ];

  it("prefers an exact match over containment", () => {
    expect(matchTarget(owned, "pay rent").map((r) => r.text)).toEqual(["pay rent"]);
  });

  it("falls back to containment", () => {
    expect(matchTarget(owned, "pay").map((r) => r.text)).toEqual([
      "pay rent",
      "pay the phone bill"
    ]);
  });

  it("ignores case and punctuation", () => {
    expect(matchTarget(owned, "stretch").map((r) => r.text)).toEqual(["Stretch!"]);
  });

  it("matches nothing for an empty target", () => {
    expect(matchTarget(owned, " ?! ")).toEqual([]);
  });
});

describe("list and cancel wording", () => {
  it("lists waiting reminders with time left, then finished ones", () => {
    const list: ReminderList = {
      now: NOW,
      open: [reminder("stretch", "queued", 90), reminder("call Sam", "queued", -2)],
      finished: [reminder("water plants", "delivered"), reminder("pay rent", "cancelled")]
    };
    expect(reminderListReply(list)).toBe(
      "Waiting:\n- stretch, in 1 minute and 30 seconds\n- call Sam, due now\n\n" +
        "Recent:\n- water plants (sent)\n- pay rent (cancelled)"
    );
  });

  it("says when there are no reminders at all", () => {
    expect(reminderListReply({ now: NOW, open: [], finished: [] })).toBe(
      "You don't have any reminders."
    );
  });

  it("answers honestly for each cancel outcome", () => {
    const one = reminder("stretch", "queued");
    expect(reminderCancelReply({ kind: "cancelled", reminder: one })).toBe(
      "Cancelled. I won't remind you: stretch"
    );
    expect(reminderCancelReply({ kind: "already_delivered", reminder: one })).toBe(
      "Too late to cancel, I already sent that reminder: stretch"
    );
    expect(
      reminderCancelReply({ kind: "ambiguous", matches: [one, reminder("stretch legs", "queued")] })
    ).toBe(
      "More than one reminder matches, so I didn't cancel any. Which one?\n- stretch\n- stretch legs"
    );
    expect(reminderCancelReply({ kind: "not_found" })).toBe(
      "I couldn't find a reminder like that, so nothing changed."
    );
  });
});

describe("no other way in", () => {
  it("declares no route, action or tool for reminders", () => {
    const surfaces = JSON.stringify({
      routes: chatModuleManifest.routes.map((route) => route.path),
      actions: chatModuleManifest.assistantActionFamilies,
      tools: chatModuleManifest.assistantTools
    });
    expect(surfaces).not.toMatch(/remind/i);
  });
});
