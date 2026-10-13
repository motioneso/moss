import { describe, expect, it } from "vitest";
import { matchReminderEditSelection } from "../../packages/chat/src/reminders/edit-agreement.js";
import { recognizeReminderEdit } from "../../packages/chat/src/reminders/edit-recognizer.js";

describe("typed reminder edit selection", () => {
  it.each(["yes", "ok", "okay", "Yes!"])(
    "rejects acknowledgment %j even as a whole name",
    (selection) => {
      expect(matchReminderEditSelection([{ text: selection }], selection)).toEqual([]);
    }
  );
  it("selects whole words with case and punctuation normalized", () => {
    const candidates = [{ text: "check eyes" }, { text: "book flight" }];
    expect(matchReminderEditSelection(candidates, "EYES!")).toEqual([candidates[0]]);
    expect(matchReminderEditSelection(candidates, "book flight")).toEqual([candidates[1]]);
  });
});

describe("reminder edit routing", () => {
  it.each([
    "move the couch to the left",
    "change of plans tonight",
    "can you edit this paragraph",
    "remind me in 5 minutes to move the couch",
    "what does edit reminder mean?",
    "change the reminder app subscription",
    "x".repeat(701)
  ])("leaves everyday wording %j to Moss", (text) => {
    expect(recognizeReminderEdit(text)).toBe(false);
  });
  it.each([
    "move my stretch reminder to tomorrow at 9am",
    "Can you change the reminder to call Sam to 4pm please?",
    "edit my reminder text to bring the blue folder",
    "change the deadline on my reminder to 5pm",
    "reschedule my reminder for 10 minutes from now"
  ])("routes explicit edits %j", (text) => {
    expect(recognizeReminderEdit(text)).toBe(true);
  });
});

import {
  resolveReminderEdit,
  type EditableReminder
} from "../../packages/chat/src/reminders/edit.js";
import {
  REMINDER_EDIT_GUIDANCE,
  validateReminderEdit
} from "../../packages/chat/src/reminders/edit-interpretation.js";
import type { ReminderEditTerms } from "@moss/shared";

it("keeps worked combined text/time and time-only edits within the guidance budget", () => {
  expect(REMINDER_EDIT_GUIDANCE).toContain(
    '"change my stretch reminder text to bring water and move it to 4 minutes from now"'
  );
  expect(REMINDER_EDIT_GUIDANCE).toContain('text="bring water", delaySeconds=240');
  expect(REMINDER_EDIT_GUIDANCE).toContain('"move my stretch reminder to tomorrow at 9am"');
  expect(REMINDER_EDIT_GUIDANCE).toContain("text=null, localDue=tomorrow");
  expect(REMINDER_EDIT_GUIDANCE.split(/\s+/).length).toBeLessThan(150);
});

const NOW = new Date("2026-10-12T12:00:00Z");
const current: EditableReminder = {
  id: "reminder",
  version: 1,
  reminder_text: "call Sam",
  state: "queued",
  due_at: new Date("2026-10-12T15:00:00Z"),
  deadline_at: new Date("2026-10-12T16:00:00Z"),
  timing: "local_clock",
  delay_seconds: null,
  local_due: "2026-10-12T15:00",
  time_zone: "UTC",
  repeat_kind: null,
  repeat_seconds: null
};
const keep: ReminderEditTerms = {
  text: null,
  delaySeconds: null,
  localDue: null,
  deadline: "keep",
  localDeadline: null
};

describe("validated reminder field changes", () => {
  it("changes text without altering time or deadline", () => {
    expect(
      resolveReminderEdit(current, { ...keep, text: "bring the blue folder" }, NOW, "UTC")
    ).toMatchObject({
      reminder_text: "bring the blue folder",
      due_at: new Date("2026-10-12T15:00:00Z"),
      deadline_at: new Date("2026-10-12T16:00:00Z")
    });
  });
  it("refuses a moved time that would silently discard the existing deadline", () => {
    expect(() =>
      resolveReminderEdit(current, { ...keep, localDue: "2026-10-12T17:00" }, NOW, "UTC")
    ).toThrow(/deadline/);
  });
  it("moves the time and removes the deadline only when explicitly requested", () => {
    expect(
      resolveReminderEdit(
        current,
        { ...keep, localDue: "2026-10-12T17:00", deadline: "remove" },
        NOW,
        "UTC"
      )
    ).toMatchObject({ due_at: new Date("2026-10-12T17:00:00Z"), deadline_at: null });
  });
  it("sets the requested deadline without changing due time", () => {
    expect(
      resolveReminderEdit(
        current,
        { ...keep, deadline: "set", localDeadline: "2026-10-12T18:00" },
        NOW,
        "UTC"
      )
    ).toMatchObject({ due_at: current.due_at, deadline_at: new Date("2026-10-12T18:00:00Z") });
  });
  it.each(["2026-11-01T01:30", "2027-03-14T02:30"])(
    "rejects ambiguous or skipped local time %s",
    (localDue) => {
      expect(() =>
        resolveReminderEdit(
          { ...current, deadline_at: null },
          { ...keep, localDue },
          new Date("2026-10-31T12:00:00Z"),
          "America/Los_Angeles"
        )
      ).toThrow();
    }
  );
  it.each([0, 2592001, 1.5])("rejects an invalid relative delay %s", (delaySeconds) => {
    expect(() =>
      resolveReminderEdit({ ...current, deadline_at: null }, { ...keep, delaySeconds }, NOW, "UTC")
    ).toThrow();
  });
  it("refuses model output attempting to add permission fields", () => {
    expect(
      validateReminderEdit({
        ...keep,
        target: "call Sam",
        unsupported: false,
        recipient: "another owner"
      })
    ).toBeUndefined();
  });
  it("refuses a malformed or contradictory date extraction", () => {
    expect(
      validateReminderEdit({ ...keep, target: null, unsupported: false, localDue: "tomorrow" })
    ).toBeUndefined();
    expect(
      validateReminderEdit({ ...keep, target: null, unsupported: false, deadline: "set" })
    ).toBeUndefined();
  });
});

it("preserves repetition on text-only edits", () => {
  expect(
    resolveReminderEdit(
      { ...current, repeat_kind: "daily" },
      { ...keep, text: "drink water" },
      NOW,
      "UTC"
    )
  ).toMatchObject({ repeat_kind: "daily", due_at: current.due_at });
});
it("changes recurrence and accepts an absolute stop beyond one cycle", () => {
  expect(
    resolveReminderEdit(
      current,
      { ...keep, repeat: { kind: "daily" }, deadline: "set", localDeadline: "2026-10-15T18:00" },
      NOW,
      "UTC"
    )
  ).toMatchObject({ repeat_kind: "daily", deadline_at: new Date("2026-10-15T18:00Z") });
});
