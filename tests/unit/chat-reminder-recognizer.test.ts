import { describe, expect, it } from "vitest";

import { recognizeRelativeReminder } from "../../packages/chat/src/reminders/recognizer.js";

describe("relative reminder recognizer", () => {
  it.each([
    ["remind me in 10 minutes to stretch", 600, "stretch"],
    ["Remind me in 10 minutes, check the Oven", 600, "check the Oven"],
    ["remind me in 5min take the bread out", 300, "take the bread out"],
    ["Can you please remind me in 2 hours to call Sam?", 7200, "call Sam"],
    ["hey moss, remind me in 30 secs to breathe. thanks", 30, "breathe"],
    ["remind me to water the plants in 3 days", 259_200, "water the plants"],
    ["remind me about the dentist in 1 hr", 3600, "the dentist"],
    ["set a reminder for 45 minutes: move the car", 2700, "move the car"],
    ["set me a reminder to send the invoice in 1 day", 86_400, "send the invoice"],
    ["remind   me\nin 1 s to blink", 1, "blink"],
    ["remind me in 30 days to renew", 2_592_000, "renew"],
    ["remind me in 5 minutes to call Sam about 3 invoices", 300, "call Sam about 3 invoices"],
    ["remind me in 5 minutes to order 2 or 3 pizzas", 300, "order 2 or 3 pizzas"]
  ])("saves %j", (raw, delaySeconds, text) => {
    expect(recognizeRelativeReminder(raw)).toEqual({ kind: "request", delaySeconds, text });
  });

  it.each([
    "what is the weather",
    "remind me what I said yesterday",
    "remind me of my password",
    "remind me about the plan",
    "I forgot to set an alarm in 10 minutes",
    "reminders are useful",
    "remind me, what did we decide?",
    "remind me the name of that restaurant",
    "remind me my wifi password",
    "remind me again what the plan was",
    "remind me in which file the config lives",
    ""
  ])("ignores %j", (raw) => {
    expect(recognizeRelativeReminder(raw)).toEqual({ kind: "none" });
  });

  it.each([
    ["remind me to stretch", "needs_relative_duration"],
    ["remind me later to stretch", "needs_relative_duration"],
    ["remind me in ten minutes to stretch", "needs_relative_duration"],
    ["remind me in 1.5 hours to stretch", "needs_relative_duration"],
    ["remind me in 2 weeks to stretch", "needs_relative_duration"],
    ["remind me in 10 m to stretch", "needs_relative_duration"],
    ["remind me tomorrow at 9am to stretch", "needs_relative_duration"],
    ["set a reminder", "needs_relative_duration"],
    ["remind me in an hour to stretch", "needs_relative_duration"],
    ["remind me soon to stretch", "needs_relative_duration"],
    ["remind me in 0 minutes to stretch", "out_of_range"],
    ["remind me in 31 days to stretch", "out_of_range"],
    ["remind me in 2592001 seconds to stretch", "out_of_range"],
    ["remind me in 99999999 days to stretch", "out_of_range"],
    ["remind me in 10 minutes to stretch every day", "clock_or_recurrence"],
    ["remind me in 1 hour to leave by 5pm", "clock_or_recurrence"],
    ["remind me in 1 hour to call at 14:30", "clock_or_recurrence"],
    ["remind me in 1 hour to check tomorrow", "clock_or_recurrence"],
    ["remind me in 5 minutes to ask? then do it", "clock_or_recurrence"],
    ["remind me in 5 minutes to call in 10 minutes", "ambiguous"],
    ["remind me in 5 minutes to call Sam, or maybe 10", "ambiguous"],
    ["remind me in 10 minutes or so to stretch", "ambiguous"],
    ["remind me in 10 minutes to stretch, or so", "ambiguous"],
    ["remind me in 5 or 10 minutes to stretch", "ambiguous"],
    ["remind me in 5-10 minutes to stretch", "ambiguous"],
    ["remind me in maybe 5 minutes to stretch", "ambiguous"],
    ["remind me in about 5 minutes to stretch", "ambiguous"],
    ["remind me in 10-ish minutes to stretch", "ambiguous"],
    ["remind me in 10 minutes-ish to stretch", "ambiguous"],
    ["remind me to call Sam in 5 minutes, or maybe later", "ambiguous"],
    ["remind me to call Sam in 5 minutes or 10", "ambiguous"],
    [`remind me in 5 minutes to ${"a".repeat(501)}`, "text_length"],
    [`remind me in 5 minutes to ${"a".repeat(800)}`, "text_length"],
    [`remind me to ${"a".repeat(800)}`, "text_length"]
  ])("refuses %j", (raw, reason) => {
    expect(recognizeRelativeReminder(raw)).toEqual({ kind: "unsupported", reason });
  });

  it("keeps exactly 500 characters of text", () => {
    const text = "b".repeat(500);
    expect(recognizeRelativeReminder(`remind me in 5 minutes to ${text}`)).toEqual({
      kind: "request",
      delaySeconds: 300,
      text
    });
  });
});
