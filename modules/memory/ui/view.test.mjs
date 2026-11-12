import assert from "node:assert/strict";
import test from "node:test";
import { esc, factRows, reviewRows, historyRows, detail, empty, broken, pager } from "./view.mjs";
import { memoryApi } from "./api.mjs";

const fact = {
  id: "f1",
  objectText: "<b>likes tea</b>",
  status: "active",
  pinned: true,
  confidenceTier: "confirmed",
  recordKind: "preference",
  createdAt: "2026-11-01T10:00:00.000Z",
  sources: [{ sourceKind: "chat" }]
};

test("memory text is escaped in every row and in the detail pane", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  const rows = factRows([fact], "f1");
  assert.ok(!rows.includes("<b>"));
  assert.ok(rows.includes('aria-current="true"'));
  assert.ok(rows.includes("Confirmed"));
  assert.ok(!detail(fact, "view", false).includes("<b>likes"));
  const review = reviewRows([
    { id: "c1", title: "<i>x</i>", provenance: "inferred", recordKind: "goal" }
  ]);
  assert.ok(!review.includes("<i>"));
  assert.ok(review.includes('data-act="accept"') && review.includes('data-act="suppress"'));
  assert.ok(!historyRows([], [{ title: "<u>y</u>", status: "suppressed" }]).includes("<u>"));
});

test("the phone detail pane has a back button and the desktop one does not", () => {
  assert.ok(detail(fact, "view", true).includes('data-act="close"'));
  assert.ok(!detail(fact, "view", false).includes('data-act="close"'));
});

test("empty and broken states render without coloured left borders or inline styles", () => {
  for (const html of [empty(), broken(false)]) {
    assert.ok(html.length > 0);
    assert.ok(!html.includes("style="));
  }
  assert.equal(typeof pager(1, 5, true, 12), "string");
});

test("the api maps a failure status to an error and passes bodies through", async () => {
  const calls = [];
  const api = memoryApi({
    request: async (method, path, body) => {
      calls.push([method, path, body]);
      if (path.startsWith("/dashboard")) return { status: 200, body: { items: [] } };
      return { status: 409, body: { error: "Ambiguous" } };
    }
  });
  assert.deepEqual(await api.facts({ q: "tea", status: "" }), { items: [] });
  assert.equal(calls[0][1], "/dashboard?q=tea");
  await assert.rejects(
    api.decide("c1", "accept"),
    (e) => e.status === 409 && e.detail === "Ambiguous"
  );
  assert.deepEqual(calls[1], ["POST", "/candidates/c1/accept", {}]);
});
