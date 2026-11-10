/* global document, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

for (const failed of ["subtasks", "tags"]) {
  test(
    `real detail panels recover from failed ${failed} without losing other panels or drafts`,
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
      const panel = failed === "tags" ? "task-tags" : failed;
      const tag = { id: "tag", name: "saved", listId: "inbox" };
      let task = {
        id: "one",
        title: "Detail task",
        listId: "inbox",
        status: "todo",
        priority: null,
        parentTaskId: null,
        dueAt: null,
        tags: [tag]
      };
      let child = { ...task, id: "child", title: "Saved child", parentTaskId: "one", tags: [] };
      let failReads = true;
      const calls = [];
      globalThis.__tasksDetails = {
        theme: async () => ({}),
        resize: async () => {},
        dispose() {},
        async request(method, path, body) {
          calls.push({ method, path, body });
          if (path === "/tasks") return { tasks: [task] };
          if (path === "/tasks/lists") return { lists: [{ id: "inbox", name: "Inbox" }] };
          if (path === "/tasks/local-day") return { timezone: "UTC", date: "2026-11-09" };
          if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
          if (path.endsWith("/subtasks")) {
            if (failed === "subtasks" && failReads) throw new Error("offline subtasks");
            return { tasks: task.id === "one" ? [child] : [] };
          }
          if (path.endsWith("/tags")) {
            if (failed === "tags" && failReads) throw new Error("offline tags");
            return {
              tags: task.id === "one" ? [tag, { ...tag, id: "other", name: "available" }] : []
            };
          }
          if (path.endsWith("/activity"))
            return {
              activity: [
                {
                  activityType: "comment",
                  body: "Saved comment",
                  createdAt: "2026-11-09T12:00:00Z"
                }
              ]
            };
          if (path === "/tasks/child" && method === "PATCH") {
            child = { ...child, ...body };
            return { task: child };
          }
          if (path === `/tasks/${task.id}`) return { task };
          throw new Error(`Unexpected ${method} ${path}`);
        }
      };
      const settled = async () => {
        for (let i = 0; i < 100; i++) {
          if (!$("tasks-app").hasAttribute("aria-busy")) return;
          await delay(5);
        }
        assert.fail("controller did not settle");
      };
      const click = async (selector) => {
        document.querySelector(selector).click();
        await settled();
      };
      try {
        let source = readFileSync(
          process.env.TASKS_APP_SOURCE || new URL("./app.mjs", import.meta.url),
          "utf8"
        );
        source = source.replace(
          'import { moduleClient } from "./guest-bridge.mjs";',
          "const moduleClient = () => globalThis.__tasksDetails;"
        );
        source = source.replaceAll(
          /from "(\.\/.+?\.mjs)"/g,
          (_match, path) => `from "${new URL(path, import.meta.url).href}"`
        );
        await import(
          `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${failed}`
        );
        await settled();
        await click("#task-results .jds-btn");
        assert.equal(
          $("task-extras").hidden,
          false,
          "one failed detail read must not hide all panels"
        );
        assert.equal($("edit-error").hidden, true);
        assert.match($("activity").textContent, /Saved comment/);
        assert.equal($(`${panel}-error`).hidden, false);
        assert.equal($(`${panel}-empty`).hidden, true, "a failed read must not claim no data");
        assert.match(
          $("task-tags").textContent,
          /saved/,
          "assigned tags remain available without suggestions"
        );
        if (failed === "tags") assert.match($("subtasks").textContent, /Saved child/);
        $("title").value = "Unsaved title";
        $("subtask-title").value = "Unsaved child";
        $("tag-name").value = "Unsaved tag";
        $("comment").value = "Unsaved comment";
        const writes = () => calls.filter((call) => call.method !== "GET").length;
        const before = writes();
        failReads = false;
        await click(`[data-action="retry-${panel}"] button`);
        assert.equal($(`${panel}-error`).hidden, true);
        assert.match($("subtasks").textContent, /Saved child/);
        assert.match($("task-tags").textContent, /available/);
        assert.equal(writes(), before, "retry is a read only");
        assert.equal($("title").value, "Unsaved title");
        assert.equal($("subtask-title").value, "Unsaved child");
        assert.equal($("tag-name").value, "Unsaved tag");
        assert.equal($("comment").value, "Unsaved comment");
        failReads = true;
        await click('#subtasks input[type="checkbox"]');
        assert.equal(writes(), before + 1);
        assert.equal($(`${panel}-error`).hidden, false);
        assert.match(
          $("subtasks").textContent,
          /Saved child/,
          "failed refresh keeps loaded children"
        );
        assert.match($("task-tags").textContent, /available/, "failed refresh keeps loaded tags");
        failReads = false;
        await click(`[data-action="retry-${panel}"] button`);
        assert.equal(writes(), before + 1, "retry must not repeat a completion");
        assert.equal(document.querySelector('#subtasks input[type="checkbox"]').checked, true);
        await click('[data-action="close-editor"] button');
        assert.equal(
          $("discard-draft").hidden,
          false,
          "read retries must not mark unsaved edits as saved"
        );
        await click('[data-action="discard-changes"] button');
        task = { ...task, id: "two", title: "Other task", tags: [] };
        await click('[data-action="reload"] button');
        await click("#task-results .jds-btn");
        assert.equal($("subtasks").textContent, "", "switching tasks clears prior children");
        assert.equal($("task-tags").textContent, "", "switching tasks clears prior tags");
        assert.equal($("subtasks-empty").hidden, false);
        assert.equal($("task-tags-empty").hidden, false);
      } finally {
        dom.window.close();
        for (const key of keys) {
          if (old[key] === undefined) delete globalThis[key];
          else globalThis[key] = old[key];
        }
        delete globalThis.__tasksDetails;
      }
    }
  );
}
