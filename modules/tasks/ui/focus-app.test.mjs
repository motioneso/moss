/* global document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "focus presets override status, keep other filters and clear without writes",
  {
    skip: !process.env.TASKS_SCREEN_BIN
  },
  async () => {
    const dom = new JSDOM(
      execFileSync(process.env.TASKS_SCREEN_BIN, ["--screen"], {
        encoding: "utf8"
      }),
      { url: "https://tasks.example.test" }
    );
    const keys = ["document", "window", "Option", "FormData"];
    const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
    for (const key of keys) globalThis[key] = dom.window[key];
    const $ = (id) => document.getElementById(id);
    const base = {
      description: null,
      listId: "home",
      status: "todo",
      priority: 5,
      effort: null,
      dueAt: new Date().toISOString(),
      doAt: null,
      completedAt: null,
      recurrence: null,
      parentTaskId: null,
      tags: [{ id: "red", name: "red" }]
    };
    const tasks = [
      { ...base, id: "high", title: "High priority" },
      { ...base, id: "low", title: "Low priority", priority: 1 },
      { ...base, id: "done", title: "Finished today", status: "done", completedAt: base.dueAt },
      {
        ...base,
        id: "old",
        title: "Finished earlier",
        status: "done",
        completedAt: "2000-01-01T12:00:00Z"
      },
      { ...base, id: "child", title: "Hidden child", parentTaskId: "high" },
      { ...base, id: "work", title: "Work priority", listId: "work", tags: [] }
    ];
    const calls = [];
    globalThis.__tasksFocus = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path) {
        calls.push({ method, path });
        if (path === "/tasks") return { tasks };
        if (path === "/tasks/local-day") return { timezone: "Pacific/Kiritimati" };
        if (path === "/tasks/lists")
          return {
            lists: [
              { id: "home", name: "Home" },
              { id: "work", name: "Work" }
            ]
          };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        throw new Error(`Unexpected ${method} ${path}`);
      }
    };
    const settle = async () => {
      for (let i = 0; i < 100; i++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("focus screen did not settle");
    };
    const choose = (id, value, event = "change") => {
      $(id).value = value;
      $(id).dispatchEvent(new dom.window.Event(event, { bubbles: true }));
    };
    const titles = () =>
      [...document.querySelectorAll("#task-results .tasks-row-title button")]
        .map((node) => node.textContent)
        .sort();
    try {
      const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8")
        .replace(
          'import { moduleClient } from "./guest-bridge.mjs";',
          "const moduleClient = () => globalThis.__tasksFocus;"
        )
        .replaceAll(
          /from "(\.\/.+?\.mjs)"/g,
          (_m, path) => `from "${new URL(path, import.meta.url).href}"`
        );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settle();
      assert.equal($("focus-filter").value, "");
      assert.equal($("status-filter").value, "todo");
      choose("status-filter", "archived", "input");
      assert.deepEqual(titles(), []);
      choose("focus-filter", "priorities");
      assert.equal($("status-filter").value, "");
      assert.match($("active-focus").textContent, /Do First/);
      assert.deepEqual(titles(), ["High priority", "Work priority"]);
      choose("list-filter", "home");
      choose("tag-filter", "red");
      choose("focus-filter", "atrisk");
      assert.deepEqual(titles(), ["High priority", "Low priority"]);
      assert.match($("list-filter").selectedOptions[0].textContent, /Home \(2\)/);
      choose("focus-filter", "donetoday");
      assert.deepEqual(titles(), ["Finished today"]);
      $("active-focus").querySelector("button").click();
      assert.equal($("focus-filter").value, "");
      assert.equal(document.activeElement, $("focus-filter"));
      assert.deepEqual(titles(), ["High priority", "Low priority"]);
      choose("focus-filter", "donetoday");
      choose("search", "missing", "input");
      assert.deepEqual(titles(), []);
      assert.match($("list-filter").selectedOptions[0].textContent, /Home \(1\)/);
      choose("search", "", "input");
      // Both layouts use the same focus model; rendering a layout is read-only.
      $("view").value = "matrix";
      choose("focus-filter", "donetoday");
      assert.deepEqual(titles(), ["Finished today"]);
      assert.equal($("task-results").className, "tasks-matrix");
      choose("status-filter", "done", "input");
      assert.equal($("focus-filter").value, "");
      assert.equal($("active-focus").children.length, 0);
      assert.deepEqual(titles(), ["Finished earlier", "Finished today"]);
      choose("focus-filter", "priorities");
      choose("focus-filter", "");
      assert.equal($("status-filter").value, "todo");
      assert.deepEqual(titles(), ["High priority", "Low priority"]);
      choose("focus-filter", "donetoday");
      document.querySelector('[data-action="clear-filters"] button').click();
      await settle();
      assert.equal($("focus-filter").value, "");
      assert.equal($("status-filter").value, "todo");
      assert.deepEqual(titles(), ["High priority", "Low priority", "Work priority"]);
      assert.equal($("active-tags").children.length, 0);
      assert(
        calls.every(({ method }) => method === "GET"),
        "filtering must never mutate tasks"
      );
    } finally {
      dom.window.close();
      for (const key of keys)
        if (old[key] === undefined) delete globalThis[key];
        else globalThis[key] = old[key];
      delete globalThis.__tasksFocus;
    }
  }
);
