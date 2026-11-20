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

const catchUp = {
  since: null,
  leftOutCount: 3,
  entries: Array.from({ length: 6 }, (_, i) => ({
    id: `c${i}`,
    senderName: `Sender ${i}`,
    summary: `Summary ${i}`,
    receivedAt: "2026-11-11T07:00:00.000Z",
    reason: i === 0 ? "important" : "waiting_on_them",
    cacheMessageId: `m${i}`,
    openHref: "https://mail.example/x"
  }))
};

test("catch-up shows five emails, a Show more button, and the left-out line", () => {
  const html = sectionHtml({ phase: "ready", data: { state: "none", rows: [], catchUp } }, "en");
  assert.equal((html.match(/data-entry=/g) ?? []).length, 5);
  assert.match(html, /Show 1 more/);
  assert.match(html, /Left out 3 newsletters/);
  assert.match(html, /aria-label="Dismiss email from Sender 0"/);
  assert.doesNotMatch(html, /caught up/);
});

test("a handled email shows its state and Undo, and an error shows its text", () => {
  const html = sectionHtml(
    {
      phase: "ready",
      data: { state: "rows", rows: [], catchUp },
      catchState: {
        marks: { c0: { status: "added" }, c1: { status: "dismissed" } },
        expanded: true,
        failed: "That did not save. Try again."
      }
    },
    "en"
  );
  assert.match(html, /Added to your tasks/);
  assert.match(html, /Dismissed/);
  assert.equal((html.match(/data-catch="undo"/g) ?? []).length, 2);
  assert.match(html, /That did not save/);
  assert.doesNotMatch(html, /Show \d+ more/);
});

test("an email's text is escaped", () => {
  const evil = {
    ...catchUp,
    entries: [{ id: "x", senderName: "<img onerror=1>", summary: "<b>hi</b>" }]
  };
  const html = sectionHtml(
    { phase: "ready", data: { state: "none", rows: [], catchUp: evil } },
    "en"
  );
  assert.doesNotMatch(html, /<img onerror|<b>hi/);
});

test("an email with no usable received time shows no time text", () => {
  const bare = { ...catchUp, entries: [{ id: "x", senderName: "Sam", summary: "Hi" }] };
  const html = sectionHtml(
    { phase: "ready", data: { state: "none", rows: [], catchUp: bare } },
    "en"
  );
  assert.doesNotMatch(html, /Invalid Date/);
});
