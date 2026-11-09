/* global document, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "real screen quick capture, Details handoff and acknowledged refresh retry",
  {
    skip: !process.env.TASKS_SCREEN_BIN
  },
  async () => {
    const html = execFileSync(process.env.TASKS_SCREEN_BIN, ["--screen"], { encoding: "utf8" });
    const dom = new JSDOM(html, { url: "https://tasks.example.test" });
    const keys = ["document", "window", "Option", "FormData"];
    const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
    for (const key of keys) globalThis[key] = dom.window[key];
    const $ = (id) => document.getElementById(id);
    const calls = [];
    const tasks = [];
    let failCreate = false;
    let failRefresh = false;
    let lists = [];
    globalThis.__tasksQuickAdd = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        calls.push({ method, path, body });
        if (method === "GET" && path === "/tasks") {
          if (failRefresh) {
            failRefresh = false;
            throw new Error("offline");
          }
          return { tasks: [...tasks] };
        }
        if (path === "/tasks/lists") return { lists };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        if (/\/tags$/.test(path)) return { tags: [] };
        if (method === "POST" && path === "/tasks") {
          if (failCreate) {
            failCreate = false;
            throw new Error("rejected");
          }
          if (!lists.length) lists = [{ id: "personal", name: "Personal" }];
          const task = {
            ...body,
            id: `task-${tasks.length}`,
            listId: body.listId || lists[0].id,
            status: "todo",
            priority: null,
            parentTaskId: null,
            dueAt: null,
            tags: []
          };
          tasks.push(task);
          return { task };
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }
    };
    const settled = async () => {
      for (let i = 0; i < 100; i++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("controller did not settle");
    };
    const postCount = () => calls.filter((c) => c.method === "POST" && c.path === "/tasks").length;
    try {
      let source = readFileSync(
        process.env.TASKS_APP_SOURCE || new URL("./app.mjs", import.meta.url),
        "utf8"
      );
      source = source.replace(
        'import { moduleClient } from "./guest-bridge.mjs";',
        "const moduleClient = () => globalThis.__tasksQuickAdd;"
      );
      source = source.replaceAll(
        /from "(\.\/.+?\.mjs)"/g,
        (_match, path) => `from "${new URL(path, import.meta.url).href}"`
      );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settled();
      assert.ok($("quick-task-form"), "legacy quick capture must be reachable in the real screen");
      const add = $("quick-task-form").querySelector('button[type="submit"]');
      $("quick-title").value = "   ";
      $("quick-title").dispatchEvent(new window.Event("input"));
      add.click();
      await settled();
      assert.equal(postCount(), 0);
      $("quick-title").value = "  First quick task  ";
      $("quick-title").dispatchEvent(new window.Event("input"));
      add.click();
      add.click();
      await settled();
      assert.equal(postCount(), 1, "repeated activation must admit once");
      assert.deepEqual(calls.find((c) => c.method === "POST").body, { title: "First quick task" });
      assert.equal($("quick-title").value, "");
      assert.match($("task-results").textContent, /First quick task/);
      assert.equal(document.activeElement, $("quick-title"));
      lists.push({ id: "home", name: "Home" });
      document.querySelector('[data-action="reload"] button').click();
      await settled();
      $("list-filter").value = "home";
      $("list-filter").dispatchEvent(new window.Event("change"));
      failCreate = true;
      $("quick-title").value = "Keep after failure";
      $("quick-title").dispatchEvent(new window.Event("input"));
      add.click();
      await settled();
      assert.equal($("quick-title").value, "Keep after failure");
      assert.equal($("quick-error").hidden, false);
      failRefresh = true;
      add.click();
      await settled();
      assert.equal(tasks.length, 2);
      assert.deepEqual(calls.filter((c) => c.method === "POST").at(-1).body, {
        title: "Keep after failure",
        listId: "home"
      });
      assert.match($("quick-error").textContent, /saved/);
      const beforeRetry = postCount();
      add.click();
      await settled();
      assert.equal(postCount(), beforeRetry, "refresh retry must not recreate acknowledged task");
      assert.equal($("quick-title").value, "");
      assert.equal($("quick-error").hidden, true);
      $("quick-title").value = "More detail";
      $("quick-title").dispatchEvent(new window.Event("input"));
      $("quick-details").querySelector("button").click();
      await settled();
      assert.equal($("editor").hidden, false);
      assert.equal($("title").value, "More detail");
      assert.equal($("task-list").value, "home");
      assert.equal(postCount(), beforeRetry, "Details must not create a task");
      document.querySelector('[data-action="close-editor"] button').click();
      await settled();
      assert.equal($("discard-draft").hidden, false, "handed-off title is an unsaved draft");
    } finally {
      delete globalThis.__tasksQuickAdd;
      for (const key of keys) {
        if (old[key] === undefined) delete globalThis[key];
        else globalThis[key] = old[key];
      }
      dom.window.close();
    }
  }
);
