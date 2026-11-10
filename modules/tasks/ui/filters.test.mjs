import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { taskFilters } from "./filters.mjs";

test("custom list choices keep New task on a real list, and reset restores open tasks", () => {
  const dom = new JSDOM(`<select id="list-filter"></select><select id="tag-filter"></select>
    <select id="status-filter"><option value="todo">Open</option><option value="all">All</option></select>
    <select id="focus-filter"><option value="">No focus</option></select><div id="active-focus"></div>
    <input id="search"><div id="list-selection"></div><div id="active-tags"></div>`);
  const previous = { document: globalThis.document, Option: globalThis.Option };
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  try {
    const $ = (id) => dom.window.document.getElementById(id);
    const lists = [
      { id: "home", name: "Home" },
      { id: "work", name: "Work" }
    ];
    const tasks = lists.map((list) => ({
      id: list.id,
      listId: list.id,
      parentTaskId: null,
      title: list.name,
      status: "todo",
      tags: [{ name: list.id }]
    }));
    let visible;
    const filters = taskFilters(() => {
      visible = filters.apply(tasks, lists);
    });
    visible = filters.apply(tasks, lists);
    const select = (id, value) => {
      $(id).value = value;
      $(id).dispatchEvent(new dom.window.Event("change"));
    };
    select("list-filter", "work");
    assert.equal(filters.defaultListId(lists), "work");
    select("list-state-home", "solo");
    assert.equal($("list-filter").value, "__custom");
    assert.equal(
      filters.defaultListId(lists),
      "home",
      "Multiple solo lists default to the first real list"
    );
    select("list-state-work", "excluded");
    assert.equal(
      filters.defaultListId(lists),
      "home",
      "Custom exclusions never become a write identifier"
    );
    assert.deepEqual(
      visible.map((task) => task.id),
      ["home"]
    );
    $("list-state-home").focus();
    select("list-state-home", "excluded");
    assert.equal(dom.window.document.activeElement.id, "list-state-home");
    assert.deepEqual(visible, []);
    filters.clear();
    select("tag-filter", "home");
    select("tag-filter", "work");
    assert.equal($("active-tags").children.length, 2);
    assert.equal(visible.length, 2, "Manual tags use any matching tag");
    $("active-tags").querySelector("button").click();
    assert.deepEqual(
      visible.map((task) => task.id),
      ["work"]
    );
    assert.equal(dom.window.document.activeElement.id, "tag-filter");
    $("status-filter").value = "all";
    $("search").value = "missing";
    visible = filters.apply(tasks, lists);
    assert.deepEqual(visible, []);
    assert.equal(
      $("list-filter").options[0].text,
      "All lists (1)",
      "Search must not change counts"
    );
    filters.clear();
    assert.equal($("status-filter").value, "todo");
    assert.equal($("search").value, "");
    assert.equal($("list-filter").value, "");
    assert.equal($("active-tags").children.length, 0);
    assert.equal(visible.length, 2);
    assert.equal(filters.defaultListId([]), "");
    // Read both unchanged legacy JSX expressions, rather than recreating their defaults.
    const page = readFileSync(
      new URL("../../../apps/web/src/tasks/tasks-page.tsx", import.meta.url),
      "utf8"
    );
    const quick = page.match(/<TaskCapture\s+defaultListId=\{([^}]+)\}/)[1];
    const details = page.match(/<TaskDetailsDialog[\s\S]*?defaultListId=\{([^}]+)\}/)[1];
    for (const home of ["included", "solo", "excluded"]) {
      for (const work of ["included", "solo", "excluded"]) {
        select("list-state-home", home);
        select("list-state-work", work);
        const soloIds = [home === "solo" ? "home" : null, work === "solo" ? "work" : null].filter(
          Boolean
        );
        const context = { lists, soloIds };
        assert.equal(filters.captureListId(lists), runInNewContext(quick, context));
        assert.equal(filters.defaultListId(lists), runInNewContext(details, context));
      }
    }
  } finally {
    globalThis.document = previous.document;
    globalThis.Option = previous.Option;
    dom.window.close();
  }
});
