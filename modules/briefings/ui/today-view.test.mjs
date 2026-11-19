import test from "node:test";
import assert from "node:assert/strict";
import { sectionHtml } from "./today-view.mjs";

const row = (over = {}) => ({
  taskId: "t1",
  title: "Send the <b>deck</b>",
  explanation: "Asked for on Monday",
  status: "suggested",
  primaryAction: { kind: "reply", cacheMessageId: "m1" },
  ...over
});
const ready = (rows, state = "rows") => ({ phase: "ready", data: { state, rows } });

test("a suggested row offers Reply, Accept and Dismiss", () => {
  const html = sectionHtml(ready([row()]));
  assert.match(html, /1 needs you/);
  assert.match(html, /data-reply="m1"/);
  assert.match(html, /data-act="accept"/);
  assert.match(html, /data-act="dismiss"/);
});

test("accepted and dismissed rows show a label and no buttons", () => {
  const html = sectionHtml(
    ready([row({ status: "accepted" }), row({ taskId: "t2", status: "dismissed" })])
  );
  assert.match(html, /Accepted/);
  assert.match(html, /Dismissed/);
  assert.doesNotMatch(html, /data-act="accept"/);
  assert.match(html, /0 need you/);
});

test("row text is escaped", () => {
  assert.doesNotMatch(sectionHtml(ready([row()])), /<b>deck/);
});

test("a row with no live status shows no triage buttons", () => {
  const html = sectionHtml(ready([row({ status: null })]));
  assert.doesNotMatch(html, /data-act=/);
});

test("nothing to show hides the section, a run with no rows says caught up", () => {
  assert.equal(sectionHtml(ready([], "none")), "");
  assert.match(sectionHtml(ready([], "rows")), /caught up/);
});

test("a failed save shows the error and keeps the buttons", () => {
  const html = sectionHtml({ ...ready([row()]), error: "Could not save that. Try again." });
  assert.match(html, /Could not save that/);
  assert.match(html, /data-act="accept"/);
});
