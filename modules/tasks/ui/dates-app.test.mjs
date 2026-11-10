/* global document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "date editor waits for saved timezone and keeps the local day through save and reopen",
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
    let failCalendar = true;
    let task = {
      id: "task",
      title: "Near midnight",
      description: null,
      listId: "list",
      status: "todo",
      priority: null,
      effort: null,
      dueAt: "2026-11-08T01:30:45.123Z",
      doAt: null,
      recurrence: null,
      parentTaskId: null,
      tags: []
    };
    globalThis.__tasksDates = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        calls.push({ method, path, body });
        if (path === "/tasks/local-day") {
          if (failCalendar) throw new Error("timezone unavailable");
          return { timezone: "America/Los_Angeles", date: "2026-11-09" };
        }
        if (path === "/tasks") return { tasks: [task] };
        if (path === "/tasks/lists") return { lists: [{ id: "list", name: "Inbox" }] };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        if (path.endsWith("/activity")) return { activity: [] };
        if (path.endsWith("/subtasks")) return { tasks: [] };
        if (path.endsWith("/tags")) return { tags: [] };
        if (path === "/tasks/task") {
          if (method === "PATCH") task = { ...task, ...body };
          return { task };
        }
        throw new Error(`Unexpected ${method} ${path}`);
      }
    };
    const settled = async () => {
      for (let i = 0; i < 100; i++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("date editor did not settle");
    };
    const open = async () => {
      [...document.querySelectorAll(".tasks-row-title button")]
        .find((b) => b.textContent === task.title)
        .click();
      await settled();
    };
    const save = async () => {
      $("task-form").querySelector('button[type="submit"]').click();
      await settled();
    };
    try {
      let source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8")
        .replace(
          'import { moduleClient } from "./guest-bridge.mjs";',
          "const moduleClient = () => globalThis.__tasksDates;"
        )
        .replaceAll(
          /from "(\.\/.+?\.mjs)"/g,
          (_m, path) => `from "${new URL(path, import.meta.url).href}"`
        );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settled();
      assert.equal($("page-error").hidden, false);
      document.querySelector('[data-action="new"] button').click();
      await settled();
      assert.equal($("editor").hidden, true, "failed locale must not open a UTC editor");
      assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
      failCalendar = false;
      document.querySelector('[data-action="reload"] button').click();
      await settled();
      assert.match(document.body.textContent, /Due 2026-11-07 \(America\/Los_Angeles\)/);
      await open();
      assert.equal($("due-at").value, "2026-11-07");
      $("title").value = "Changed title";
      await save();
      let patch = calls.filter((c) => c.method === "PATCH").at(-1);
      assert.equal(Object.hasOwn(patch.body, "dueAt"), false);
      assert.equal(task.dueAt, "2026-11-08T01:30:45.123Z");
      await open();
      $("due-at").value = "2026-03-08";
      await save();
      assert.equal(task.dueAt, "2026-03-08T19:00:00.000Z");
      await open();
      assert.equal($("due-at").value, "2026-03-08");
    } finally {
      for (const key of keys)
        if (old[key] === undefined) delete globalThis[key];
        else globalThis[key] = old[key];
      delete globalThis.__tasksDates;
      dom.window.close();
    }
  }
);
