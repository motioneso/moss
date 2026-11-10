/* global document */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { interpretedSearch, searchChips, removeSearchChip } from "./search.mjs";

const empty = {
  text: null,
  status: null,
  effort: null,
  priority: null,
  quadrant: null,
  due: null,
  listIds: [],
  tagNames: []
};

test("interpreted filters apply status, show removable chips, reset on typing and recover from provider failure", async () => {
  const dom = new JSDOM(`<input id="search"><button id="interpret-search">Interpret search</button>
    <select id="status-filter"><option value="todo">Open</option><option value="done">Done</option></select>
    <select id="focus-filter"><option value="">No focus</option><option value="priorities">Do First</option></select>
    <p id="search-warning" hidden></p><div id="search-intent"></div>`);
  const old = globalThis.document;
  globalThis.document = dom.window.document;
  const calls = [];
  let response = {
    intent: { ...empty, status: "done", priority: 4, tagNames: ["red", "blue"] },
    warnings: ["Unknown list ignored"]
  };
  let pending;
  let fail = false;
  const $ = (id) => document.getElementById(id);
  try {
    const controller = interpretedSearch({
      api: async (...args) => {
        calls.push(args);
        if (fail) throw new Error("provider unavailable");
        return response;
      },
      run: (action) => {
        pending = Promise.resolve(action());
        return pending;
      },
      changed: () => controller.render([]),
      focus: (node) => node.focus()
    });
    const interpret = async () => {
      $("interpret-search").click();
      await pending;
    };
    $("search").value = "completed important tasks";
    $("search").dispatchEvent(new dom.window.Event("input"));
    $("focus-filter").value = "priorities";
    await interpret();
    assert.deepEqual(calls[0], [
      "POST",
      "/tasks/search/interpret",
      { query: "completed important tasks" }
    ]);
    assert.equal($("status-filter").value, "done");
    assert.equal($("focus-filter").value, "", "interpreted status must leave focus");
    assert.equal(controller.intent().status, null, "status is controlled by the regular picker");
    assert.equal($("search-warning").textContent, "Unknown list ignored");
    assert.equal($("search-intent").children.length, 3);
    document.querySelector('[aria-label="Remove filter Priority: 4"]').click();
    await pending;
    assert.equal(controller.intent().priority, null);
    assert.deepEqual(controller.intent().tagNames, ["red", "blue"]);
    assert.equal(document.activeElement, $("search"));
    $("search").value = "title query";
    $("search").dispatchEvent(new dom.window.Event("input"));
    assert.equal(controller.intent(), null);
    assert.equal($("search-warning").hidden, true);
    assert.equal($("status-filter").value, "done");
    response = { intent: { ...empty, effort: "quick" }, warnings: [] };
    $("focus-filter").value = "priorities";
    $("search").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true })
    );
    await pending;
    assert.equal(controller.intent().effort, "quick");
    assert.equal(
      $("focus-filter").value,
      "priorities",
      "an interpretation without status keeps focus"
    );
    fail = true;
    await interpret();
    assert.equal(controller.intent(), null);
    assert.equal($("focus-filter").value, "priorities", "a failed interpretation keeps focus");
    assert.match($("search-warning").textContent, /unavailable/);
    assert.equal($("search").value, "title query", "failed interpretation retains literal search");
    assert.equal($("search-intent").children.length, 0);
    fail = false;
    response = { intent: { ...empty, status: "todo" }, warnings: [] };
    await interpret();
    assert.equal($("status-filter").value, "todo");
    assert.equal(controller.intent(), null);
    assert.equal($("search-warning").textContent, "No structured filter found.");
    controller.clear();
    controller.render([]);
    assert.equal($("search-warning").hidden, true);
    const count = calls.length;
    $("search").value = "   ";
    $("search").dispatchEvent(new dom.window.Event("input"));
    assert.equal($("interpret-search").disabled, true);
    await interpret();
    assert.equal(calls.length, count);
  } finally {
    globalThis.document = old;
    dom.window.close();
  }
});

test("each interpreted chip removes only its own condition, including list and tag names with colons", () => {
  const intent = {
    ...empty,
    text: "needle",
    effort: "large",
    priority: 5,
    quadrant: "do",
    due: { kind: "range", dueAfter: "2026-11-01", dueBefore: "2026-11-30" },
    listIds: ["home:one", "work"],
    tagNames: ["red:one", "blue"]
  };
  const snapshot = structuredClone(intent);
  const chips = searchChips(intent, [{ id: "home:one", name: "Home" }]);
  assert.equal(chips.length, 9);
  assert.equal(chips.find((chip) => chip.key === "list:home:one").label, "List: Home");
  for (const chip of chips) {
    const reduced = removeSearchChip(intent, chip.key);
    assert.equal(searchChips(reduced, []).length, chips.length - 1);
    assert(!searchChips(reduced, []).some((candidate) => candidate.key === chip.key));
  }
  assert.equal(removeSearchChip({ ...empty, priority: 4 }, "priority"), null);
  assert.deepEqual(intent, snapshot);
});
