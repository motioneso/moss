import test from "node:test";
import assert from "node:assert/strict";
import { goalsHtml } from "./view.mjs";

test("empty and closed goals leave Today quiet", () => {
  assert.equal(goalsHtml([]), "");
  assert.equal(goalsHtml([{ status: "completed" }, { status: "archived" }]), "");
});

test("active rows keep the response order, wording, priority and outcome", () => {
  const html = goalsHtml([
    { status: "active", title: "Walk", desiredOutcome: "Enjoy the hills", priority: 1 },
    { status: "completed", title: "Hidden" },
    { status: "active", title: "Read", desiredOutcome: "Learn more", priority: null }
  ]);
  for (const text of [
    "Focus",
    "Long-term goals",
    "Walk",
    "Enjoy the hills",
    "P1",
    "Read",
    "Learn more"
  ]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.indexOf("Walk") < html.indexOf("Read"));
  assert.ok(!html.includes("Hidden"));
  assert.equal((html.match(/jds-drift__dot/g) ?? []).length, 1);
});

test("goal text cannot introduce markup", () => {
  const html = goalsHtml([
    {
      status: "active",
      title: '<img src=x onerror="alert(1)">',
      desiredOutcome: "<script>bad</script>"
    }
  ]);
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&lt;script&gt;bad&lt;/script&gt;"));
});
