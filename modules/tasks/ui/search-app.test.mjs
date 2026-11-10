/* global document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "real screen composes interpreted search with status, chip removal, reset and unavailable recovery",
  {
    skip: !process.env.TASKS_SCREEN_BIN
  },
  async () => {
    const html = execFileSync(process.env.TASKS_SCREEN_BIN, ["--screen"], { encoding: "utf8" });
    const dom = new JSDOM(html, { url: "https://tasks.example.test" });
    const old = Object.fromEntries(
      ["document", "window", "Option", "FormData"].map((key) => [key, globalThis[key]])
    );
    for (const key of Object.keys(old)) globalThis[key] = dom.window[key];
    let fail = false;
    const bridgeKey = "__tasksSearchAppTest";
    const rows = [
      { id: "open", title: "Open example", status: "todo", priority: 4 },
      { id: "done", title: "Finished example", status: "done", priority: 4 },
      { id: "other", title: "Other example", status: "done", priority: 1 }
    ].map((task) => ({
      ...task,
      listId: "list",
      tags: [],
      recurrence: null,
      dueAt: null,
      parentTaskId: null
    }));
    globalThis[bridgeKey] = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        if (path === "/tasks") return { tasks: rows };
        if (path === "/tasks/lists") return { lists: [{ id: "list", name: "Inbox" }] };
        if (path === "/tasks/local-day") return { timezone: "UTC", date: "2026-11-09" };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        if (path === "/tasks/search/interpret") {
          assert.equal(method, "POST");
          assert.equal(body.query, "done important tasks");
          if (fail) throw new Error("No configured provider");
          return {
            intent: {
              text: null,
              status: "done",
              effort: null,
              priority: 4,
              quadrant: null,
              due: null,
              listIds: [],
              tagNames: []
            },
            warnings: []
          };
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      }
    };
    const $ = (id) => document.getElementById(id);
    const settled = async () => {
      for (let i = 0; i < 100; i++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("screen controller did not settle");
    };
    try {
      let source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
      source = source.replace(
        'import { moduleClient } from "./guest-bridge.mjs";',
        `const moduleClient = () => globalThis.${bridgeKey};`
      );
      source = source.replaceAll(
        /from "(\.\/.+?\.mjs)"/g,
        (_match, path) => `from "${new URL(path, import.meta.url).href}"`
      );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settled();
      assert.equal($("interpret-search").querySelector("button").disabled, true);
      const type = (value) => {
        $("search").value = value;
        $("search").dispatchEvent(new dom.window.Event("input"));
      };
      type("done important tasks");
      $("interpret-search").querySelector("button").click();
      await settled();
      assert.equal($("status-filter").value, "done");
      assert.match($("task-results").textContent, /Finished example/);
      assert.doesNotMatch($("task-results").textContent, /Open example|Other example/);
      assert.equal(document.activeElement, $("search"));
      $("search-intent").querySelector("button").click();
      await settled();
      assert.equal($("search-intent").children.length, 0);
      assert.equal(
        $("empty").hidden,
        false,
        "the original literal text applies when the last condition is removed"
      );
      document.querySelector('[data-action="clear-filters"] button').click();
      await settled();
      assert.equal($("status-filter").value, "todo");
      assert.equal($("interpret-search").querySelector("button").disabled, true);
      assert.match($("task-results").textContent, /Open example/);
      fail = true;
      type("done important tasks");
      $("interpret-search").querySelector("button").click();
      await settled();
      assert.match($("search-warning").textContent, /unavailable/);
      type("Open");
      assert.match($("task-results").textContent, /Open example/);
      assert.equal($("search-warning").hidden, true);
      assert.equal($("search").disabled, false);
    } finally {
      delete globalThis[bridgeKey];
      for (const [key, value] of Object.entries(old)) globalThis[key] = value;
      dom.window.close();
    }
  }
);
