/* global document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

for (const dirtyStatus of [false, true, null]) {
  test(
    `detail refresh preserves drafts and reconciles untouched fields (status edited: ${dirtyStatus})`,
    {
      skip: !process.env.TASKS_SCREEN_BIN
    },
    async () => {
      const dom = new JSDOM(
        execFileSync(process.env.TASKS_SCREEN_BIN, ["--screen"], { encoding: "utf8" }),
        { url: "https://tasks.example.test" }
      );
      const keys = ["document", "window", "Option", "FormData"];
      const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
      for (const key of keys) globalThis[key] = dom.window[key];
      const $ = (id) => document.getElementById(id);
      let task = {
        id: "parent",
        title: "Parent task",
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
      let child = { ...task, id: "child", title: "Last subtask", parentTaskId: "parent" };
      const writes = [];
      globalThis.__tasksRefresh = {
        theme: async () => ({}),
        resize: async () => {},
        dispose() {},
        async request(method, path, body) {
          if (method !== "GET") writes.push({ method, path, body });
          if (path === "/tasks") return { tasks: [task] };
          if (path === "/tasks/local-day")
            return { timezone: "America/Los_Angeles", date: "2026-11-09" };
          if (path === "/tasks/lists") return { lists: [{ id: "list", name: "Inbox" }] };
          if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
          if (path.endsWith("/subtasks")) return { tasks: [child] };
          if (path.endsWith("/tags")) return { tags: [] };
          if (path.endsWith("/activity")) return { activity: [] };
          if (method === "PATCH" && path === "/tasks/child") {
            child = { ...child, ...body };
            // Real repository behavior when the last subtask completes; the live
            // gate separately exercises this cascade against the compiled guest.
            task = { ...task, status: "done", priority: 4, dueAt: "2026-11-10T02:30:00.000Z" };
            return { task: child };
          }
          if (path === "/tasks/parent") {
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
        assert.fail("editor did not settle");
      };
      const click = async (selector) => {
        document.querySelector(selector).click();
        await settled();
      };
      try {
        const source = readFileSync(
          process.env.TASKS_APP_SOURCE || new URL("./app.mjs", import.meta.url),
          "utf8"
        )
          .replace(
            'import { moduleClient } from "./guest-bridge.mjs";',
            "const moduleClient = () => globalThis.__tasksRefresh;"
          )
          .replaceAll(
            /from "(\.\/.+?\.mjs)"/g,
            (_m, path) => `from "${new URL(path, import.meta.url).href}"`
          );
        await import(
          `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${dirtyStatus}`
        );
        await settled();
        await click("#task-results .jds-btn");
        if (dirtyStatus !== null) {
          $("title").value = "My draft title";
          $("comment").value = "My draft comment";
        }
        if (dirtyStatus) {
          $("task-status").value = "archived";
          $("due-at").value = "2026-12-15";
        }
        await click('#subtasks input[type="checkbox"]');
        assert.equal($("title").value, dirtyStatus === null ? "Parent task" : "My draft title");
        assert.equal($("comment").value, dirtyStatus === null ? "" : "My draft comment");
        assert.equal(
          $("task-status").value,
          dirtyStatus ? "archived" : "done",
          "untouched status must follow the completed parent; explicit draft status wins"
        );
        assert.equal($("priority").value, "4");
        assert.equal(
          $("due-at").value,
          dirtyStatus ? "2026-12-15" : "2026-11-09",
          "refresh uses the editor's saved timezone while keeping edited dates"
        );
        await click('[data-action="close-editor"] button');
        assert.equal(
          $("discard-draft").hidden,
          dirtyStatus === null,
          "a refresh must neither create a false draft nor mark real drafts saved"
        );
        if (dirtyStatus === null) return;
        await click('[data-action="keep-editing"] button');
        await click('#task-form button[type="submit"]');
        const patch = writes.find((write) => write.path === "/tasks/parent");
        assert.equal(patch.body.title, "My draft title");
        assert.equal(patch.body.priority, 4);
        assert.equal(
          Object.hasOwn(patch.body, "dueAt"),
          dirtyStatus,
          "untouched refreshed timestamp must not be rounded to noon"
        );
        assert.equal(
          patch.body.status,
          dirtyStatus ? "archived" : undefined,
          "save must not replay stale status"
        );
        if (dirtyStatus) assert.equal(patch.body.dueAt, "2026-12-15T20:00:00.000Z");
        assert.equal(task.status, dirtyStatus ? "archived" : "done");
      } finally {
        dom.window.close();
        for (const key of keys)
          if (old[key] === undefined) delete globalThis[key];
          else globalThis[key] = old[key];
        delete globalThis.__tasksRefresh;
      }
    }
  );
}
