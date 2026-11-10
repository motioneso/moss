import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantTrackedCount,
  driftMark,
  effortLabel,
  isAssistantSource,
  trackingNote
} from "./row-marks.mjs";

const now = new Date("2026-11-10T20:00:00Z");
const task = (dueAt, status = "todo") => ({ dueAt, status });

test("drift follows the account day, not UTC", () => {
  // 03:00 UTC on the 10th is still the 9th in Los Angeles.
  assert.equal(
    driftMark(task("2026-11-10T03:00:00Z"), now, "America/Los_Angeles")?.kind,
    "overdue"
  );
  assert.equal(driftMark(task("2026-11-10T03:00:00Z"), now, "UTC")?.kind, "atrisk");
});

test("drift windows", () => {
  assert.equal(driftMark(task("2026-11-09T12:00:00Z"), now)?.label, "Overdue");
  assert.equal(driftMark(task("2026-11-12T12:00:00Z"), now)?.label, "At risk");
  assert.equal(driftMark(task("2026-11-13T12:00:00Z"), now), null);
  assert.equal(driftMark(task(null), now), null);
  assert.equal(driftMark(task("2026-11-01T12:00:00Z", "done"), now), null);
});

test("effort and source marks", () => {
  assert.equal(effortLabel("quick"), "Small");
  assert.equal(effortLabel(null), null);
  assert.equal(isAssistantSource("email"), true);
  assert.equal(isAssistantSource("user"), false);
  assert.equal(isAssistantSource("Manual"), false);
  assert.equal(isAssistantSource(""), false);
});

test("tracking note counts open assistant tasks", () => {
  const tasks = [
    { source: "chat", status: "todo" },
    { source: "email", status: "suggested" },
    { source: "chat", status: "done" },
    { source: "user", status: "todo" }
  ];
  assert.equal(assistantTrackedCount(tasks), 2);
  assert.match(trackingNote(2), /tracking 2 tasks/);
  assert.match(trackingNote(1), /tracking 1 task /);
  assert.equal(trackingNote(0), "");
});
