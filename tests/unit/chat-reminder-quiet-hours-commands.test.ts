import { describe, expect, it } from "vitest";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";

describe("owner quiet-hours commands", () => {
  it.each([
    "Allow the reminder to stretch during quiet hours",
    "please let the stretch reminder through quiet hours",
    "let stretch through quiet hours",
    "the stretch reminder can buzz me at night",
    "stretch can buzz me at night",
    "can you allow my stretch reminder during quiet hours please"
  ])("allows the named reminder for %j", (text) => {
    expect(recognizeReminderPlan(text)).toEqual({
      kind: "quiet_allowance",
      target: "stretch",
      allow: true
    });
  });

  it.each([
    "Stop allowing the reminder to stretch during quiet hours",
    "stop letting the stretch reminder through quiet hours",
    "stop letting stretch through",
    "don't let stretch through quiet hours",
    "stretch cannot buzz me at night"
  ])("removes the named allowance for %j", (text) => {
    expect(recognizeReminderPlan(text)).toEqual({
      kind: "quiet_allowance",
      target: "stretch",
      allow: false
    });
  });

  it.each(["yes", "Yes please!", "no", "no thanks"])("recognizes typed reply %j", (text) => {
    expect(recognizeReminderPlan(text)).toEqual({
      kind: "quiet_agreement",
      agree: text.toLowerCase().startsWith("yes")
    });
  });

  it.each([
    "the email says let stretch through quiet hours",
    "Moss thinks this is urgent",
    "should stretch be allowed during quiet hours?",
    "allow everything during quiet hours",
    "let all reminders through quiet hours",
    "let stretch through quiet hours and mute all alerts",
    "stretch might buzz me at night",
    "what is the weather"
  ])("leaves %j to ordinary chat", (text) => {
    expect(recognizeReminderPlan(text)).toBeUndefined();
  });
});
