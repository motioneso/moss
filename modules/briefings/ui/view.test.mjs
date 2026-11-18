import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequest,
  findDefinition,
  replyPrompt,
  sourceLabels,
  sourceListDescription,
  splitHeadline,
  targetTimeFor,
  toggleToolName,
  updateRequest
} from "./view.mjs";
import { renderMarkdown, safeHref } from "./markdown.mjs";

test("default times follow the briefing type", () => {
  assert.equal(targetTimeFor(undefined, "morning"), "07:00");
  assert.equal(targetTimeFor(undefined, "evening"), "19:00");
  assert.equal(targetTimeFor({ scheduleMetadata: { targetTime: "06:15" } }, "morning"), "06:15");
});

test("create and update requests carry only what changed", () => {
  const made = createRequest({ briefingType: "evening", timezone: "Europe/London" });
  assert.equal(made.title, "Evening review");
  assert.equal(made.scheduleMetadata.timezone, "Europe/London");
  const def = { scheduleMetadata: { targetTime: "07:00", timezone: "UTC" } };
  assert.deepEqual(updateRequest(def, { enabled: false }), { enabled: false });
  assert.deepEqual(updateRequest(def, { targetTime: "08:00" }), {
    scheduleMetadata: { targetTime: "08:00", timezone: "UTC" }
  });
});

test("tool toggling adds and removes", () => {
  assert.deepEqual(toggleToolName(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleToolName(["a", "b"], "a"), ["b"]);
  assert.equal(findDefinition([{ briefingType: "morning" }], "evening"), undefined);
});

test("sources are named by module", () => {
  assert.deepEqual(sourceLabels(["tasks.listOpen", "calendar.today", "tasks.done"]), [
    "Calendar",
    "Tasks"
  ]);
  assert.match(sourceListDescription([]), /at least one/);
  assert.match(sourceListDescription(["Tasks"]), /1 read-only source available/);
});

test("the headline splits off the first sentence", () => {
  assert.deepEqual(splitHeadline("Busy day. Two meetings."), {
    headline: "Busy day.",
    rest: "Two meetings."
  });
});

test("reply prompt names only the cached id", () => {
  assert.equal(replyPrompt("c1"), "Draft a reply to the cached email c1 using email.draftReply.");
});

test("model text cannot inject html, images or script links", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.ok(safeHref("https://example.com/a"));
  const html = renderMarkdown(
    "<img src=x onerror=alert(1)> ![p](https://x/y.png) [bad](javascript:alert(1))"
  );
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("<script"));
});
