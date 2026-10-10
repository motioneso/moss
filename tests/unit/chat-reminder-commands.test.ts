import { describe, expect, it } from "vitest";

import { chatModuleManifest } from "../../packages/chat/src/manifest.js";
import type { DataContextDb } from "@moss/db";

import {
  cancelReminder,
  matchTarget,
  type ReminderList
} from "../../packages/chat/src/reminders/cancel.js";
import {
  recognizeReminderCommand,
  recognizeReminderPlan
} from "../../packages/chat/src/reminders/commands.js";
import type {
  OwnedReminder,
  ReminderRepository
} from "../../packages/chat/src/reminders/repository.js";
import {
  reminderCancelReply,
  reminderListReply
} from "../../packages/chat/src/reminders/wording.js";

// #3310: list and cancel are recognised only from the user's own words and answered by code.

function reminder(
  text: string,
  state: OwnedReminder["state"],
  dueInSeconds = 600,
  id = `id-${text}`,
  contextState: OwnedReminder["contextState"] = "pending"
): OwnedReminder {
  return {
    id,
    text,
    state,
    contextState,
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

// Stands in for the repository: rows are given newest first, as listOwned returns them.
function fakeRepository(owned: OwnedReminder[]) {
  const cancelled: string[] = [];
  const dismissed: string[] = [];
  const repository = {
    listOwned: async () => owned,
    lockForCancel: async (_db: DataContextDb, id: string) =>
      owned.find((candidate) => candidate.id === id),
    markCancelled: async (_db: DataContextDb, id: string) => void cancelled.push(id),
    dismissContext: async (_db: DataContextDb, id: string) => void dismissed.push(id)
  } as unknown as ReminderRepository;
  return { repository, cancelled, dismissed };
}

const DB = {} as DataContextDb;

describe("deciding what a cancel does", () => {
  it("prefers a waiting reminder over a finished one with the exact words", async () => {
    const { repository, cancelled } = fakeRepository([
      reminder("stretch", "delivered", -60, "old"),
      reminder("stretch legs", "queued", 600, "waiting")
    ]);
    const result = await cancelReminder(DB, repository, "stretch");
    expect(result).toMatchObject({ kind: "cancelled", reminder: { id: "waiting" }, alike: 0 });
    expect(cancelled).toEqual(["waiting"]);
  });

  it("cancels the soonest of several reminders with the same words", async () => {
    const { repository, cancelled } = fakeRepository([
      reminder("Stretch", "queued", 900, "later"),
      reminder("stretch!", "queued", 300, "sooner"),
      reminder("stretch", "queued", 600, "middle")
    ]);
    const result = await cancelReminder(DB, repository, "stretch");
    expect(result).toMatchObject({ kind: "cancelled", reminder: { id: "sooner" }, alike: 2 });
    expect(cancelled).toEqual(["sooner"]);
  });

  it("refuses to guess between different waiting reminders", async () => {
    const { repository, cancelled } = fakeRepository([
      reminder("pay rent", "queued", 300, "rent"),
      reminder("pay the phone bill", "queued", 600, "phone")
    ]);
    expect(await cancelReminder(DB, repository, "pay")).toMatchObject({ kind: "ambiguous" });
    expect(cancelled).toEqual([]);
  });

  it("with no words, settles the one just sent that still holds a place", async () => {
    const { repository, cancelled, dismissed } = fakeRepository([
      reminder("stretch", "delivered", -5, "just-sent"),
      reminder("water plants", "delivered", -600, "old", "dismissed")
    ]);
    const result = await cancelReminder(DB, repository, null);
    expect(result).toMatchObject({ kind: "already_delivered", reminder: { id: "just-sent" } });
    expect(dismissed).toEqual(["just-sent"]);
    expect(cancelled).toEqual([]);
  });

  it("with no words and nothing waiting or holding a place, changes nothing", async () => {
    const { repository, cancelled, dismissed } = fakeRepository([
      reminder("water plants", "delivered", -600, "old", "dismissed"),
      reminder("pay rent", "cancelled", 600, "rent")
    ]);
    expect(await cancelReminder(DB, repository, null)).toEqual({ kind: "none_waiting" });
    expect([...cancelled, ...dismissed]).toEqual([]);
  });

  it("says not found when nothing matches", async () => {
    const { repository } = fakeRepository([reminder("stretch", "queued")]);
    expect(await cancelReminder(DB, repository, "water plants")).toEqual({ kind: "not_found" });
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
      "Chat reminders waiting:\n- stretch, in 1 minute and 30 seconds\n- call Sam, due now\n\n" +
        "Recent chat reminders:\n- water plants (sent)\n- pay rent (cancelled)"
    );
  });

  it("says when there are no reminders at all", () => {
    expect(reminderListReply({ now: NOW, open: [], finished: [] })).toBe(
      "You haven't set any reminders in chat."
    );
  });

  it("says when nothing is waiting but some have finished", () => {
    expect(
      reminderListReply({ now: NOW, open: [], finished: [reminder("stretch", "failed")] })
    ).toBe(
      "No chat reminders are waiting.\n\nRecent chat reminders:\n- stretch (couldn't be sent)"
    );
  });

  it("answers honestly for each cancel outcome", () => {
    const one = reminder("stretch", "queued");
    expect(reminderCancelReply({ kind: "cancelled", reminder: one, alike: 0 })).toBe(
      "Cancelled. I won't remind you: stretch"
    );
    expect(reminderCancelReply({ kind: "cancelled", reminder: one, alike: 1 })).toBe(
      "Cancelled the soonest one: stretch\n1 more with the same words is still waiting."
    );
    expect(reminderCancelReply({ kind: "cancelled", reminder: one, alike: 2 })).toBe(
      "Cancelled the soonest one: stretch\n2 more with the same words are still waiting."
    );
    expect(reminderCancelReply({ kind: "already_delivered", reminder: one })).toBe(
      "Too late to cancel, I already sent that reminder: stretch"
    );
    expect(
      reminderCancelReply({ kind: "ambiguous", matches: [one, reminder("stretch legs", "queued")] })
    ).toBe(
      "More than one reminder matches, so I didn't cancel any. Which one?\n- stretch\n- stretch legs"
    );
    expect(reminderCancelReply({ kind: "needs_target", open: [one, one] })).toBe(
      "You have 2 chat reminders waiting. Which one should I cancel?\n- stretch\n- stretch"
    );
    expect(reminderCancelReply({ kind: "not_found" })).toBe(
      "I couldn't find a chat reminder like that, so nothing changed. " +
        "I can only cancel reminders you set here in chat."
    );
    expect(reminderCancelReply({ kind: "none_waiting" })).toBe(
      "You don't have any chat reminders waiting, so nothing changed."
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
