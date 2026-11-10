/* global document, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "real screen controller refreshes an abandoned partial save and resets the next capture",
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
    const parents = [];
    let taskReads = 0;
    const bridgeKey = "__tasksCaptureAppTest";
    globalThis[bridgeKey] = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        if (path === "/tasks" && method === "GET") {
          taskReads++;
          return { tasks: [...parents] };
        }
        if (path === "/tasks/lists") return { lists: [{ id: "list", name: "Inbox" }] };
        if (path === "/tasks/local-day") return { timezone: "UTC", date: "2026-11-09" };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        if (path === "/tasks" && method === "POST") {
          const task = {
            ...body,
            id: `p${parents.length}`,
            listId: "list",
            tags: [],
            recurrence: null,
            dueAt: null,
            parentTaskId: null,
            status: "todo"
          };
          parents.push(task);
          return { task };
        }
        if (path === "/tasks/lists/list/tags") return { tags: [] };
        if (path.endsWith("/breakdown")) throw new Error("transient child failure");
        throw new Error(`Unexpected request: ${method} ${path}`);
      }
    };
    const $ = (id) => document.getElementById(id);
    const click = (id) => $(id).querySelector("button").click();
    const settled = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("screen controller did not settle");
    };
    try {
      let source = readFileSync(
        process.env.TASKS_APP_SOURCE || new URL("./app.mjs", import.meta.url),
        "utf8"
      );
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
      document.querySelector('[data-action="new"] button').click();
      await settled();
      $("title").value = "Partially saved parent";
      click("add-new-subtask");
      await settled();
      const step = $("new-subtasks").querySelector("input");
      step.value = "Child to retry";
      step.dispatchEvent(new window.Event("input"));
      $("task-form").querySelector('button[type="submit"]').click();
      await settled();
      assert.equal(parents.length, 1);
      assert.equal($("edit-error").hidden, false);
      assert.equal(document.activeElement, $("task-form").querySelector('button[type="submit"]'));
      assert.equal($("task-list").disabled, true);
      document.querySelector('[data-action="close-editor"] button').click();
      await settled();
      document.querySelector('[data-action="discard-changes"] button').click();
      await settled();
      assert.equal($("overview").hidden, false);
      assert.match($("task-results").textContent, /Partially saved parent/);
      assert.equal(taskReads, 2, "discard must refresh the persisted parent");
      document.querySelector('[data-action="new"] button').click();
      await settled();
      assert.equal($("new-subtasks").children.length, 0);
      assert.equal($("task-list").disabled, false);
      $("title").value = "Separate new parent";
      $("task-form").querySelector('button[type="submit"]').click();
      await settled();
      assert.equal(parents.length, 2);
      assert.deepEqual(
        parents.map((task) => task.title),
        ["Partially saved parent", "Separate new parent"]
      );
      assert.equal($("editor").hidden, true);
    } finally {
      delete globalThis[bridgeKey];
      for (const [key, value] of Object.entries(old)) globalThis[key] = value;
      dom.window.close();
    }
  }
);
