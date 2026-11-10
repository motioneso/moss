/* global document, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "real activity panel keeps comments, retries reads and posts with the keyboard",
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
    const task = {
      id: "one",
      title: "Activity task",
      listId: "inbox",
      status: "todo",
      priority: null,
      parentTaskId: null,
      dueAt: null,
      tags: []
    };
    const entries = [
      {
        id: "first",
        body: "Earlier comment",
        activityType: "comment",
        createdAt: "2026-11-09T12:00:00Z"
      }
    ];
    entries.push({
      id: "system",
      activityType: "breakdown",
      body: "System entry hidden",
      createdAt: "2026-11-09T12:00:00Z"
    });
    const calls = [];
    let failRead = true;
    let failPost = false;
    globalThis.__tasksActivity = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        calls.push({ method, path, body });
        if (path === "/tasks") return { tasks: [task] };
        if (path === "/tasks/lists") return { lists: [{ id: "inbox", name: "Inbox" }] };
        if (path === "/tasks/local-day") return { timezone: "UTC", date: "2026-11-09" };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        if (path.endsWith("/subtasks")) return { tasks: [] };
        if (path.endsWith("/tags")) return { tags: [] };
        if (path.endsWith("/activity")) {
          if (method === "GET") {
            if (failRead) {
              failRead = false;
              throw new Error("offline read");
            }
            return { activity: [...entries] };
          }
          if (failPost) {
            failPost = false;
            throw new Error("offline write");
          }
          entries.push({
            id: String(entries.length),
            body: body.body,
            activityType: "comment",
            createdAt: "2026-11-09T12:01:00Z"
          });
          return { activity: entries.at(-1) };
        }
        if (path === "/tasks/one") return { task };
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
    const key = async (shiftKey = false) => {
      const event = new window.KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey,
        bubbles: true,
        cancelable: true
      });
      $("comment").dispatchEvent(event);
      await settled();
      return event;
    };
    const posts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/activity"));
    try {
      let source = readFileSync(
        process.env.TASKS_APP_SOURCE || new URL("./app.mjs", import.meta.url),
        "utf8"
      );
      source = source.replace(
        'import { moduleClient } from "./guest-bridge.mjs";',
        "const moduleClient = () => globalThis.__tasksActivity;"
      );
      source = source.replaceAll(
        /from "(\.\/.+?\.mjs)"/g,
        (_match, path) => `from "${new URL(path, import.meta.url).href}"`
      );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settled();
      await click("#task-results .jds-btn");
      assert.equal(
        $("task-extras").hidden,
        false,
        "an activity failure must leave the other detail controls reachable"
      );
      assert.equal($("activity-error").hidden, false);
      assert.equal($("edit-error").hidden, true);
      await click('[data-action="retry-activity"] button');
      assert.match($("activity").textContent, /Earlier comment/);
      assert.equal($("activity-error").hidden, true);
      assert.doesNotMatch($("activity").textContent, /System entry hidden/);
      $("comment").value = "  \n ";
      $("comment").dispatchEvent(new window.Event("input"));
      await key();
      assert.equal(posts().length, 0, "blank comments must not post");
      $("comment").value = "  First line\nSecond line  ";
      $("comment").dispatchEvent(new window.Event("input"));
      assert.equal(
        (await key(true)).defaultPrevented,
        false,
        "Shift+Enter keeps native newline editing"
      );
      assert.equal(posts().length, 0);
      failPost = true;
      assert.equal((await key()).defaultPrevented, true);
      assert.equal($("comment").value, "  First line\nSecond line  ");
      assert.equal($("comment-error").hidden, false);
      failRead = true;
      await key();
      assert.equal(posts().at(-1).body.body, "First line\nSecond line");
      assert.equal(
        $("comment").value,
        "",
        "an acknowledged post clears its draft even when refresh fails"
      );
      assert.match(
        $("activity").textContent,
        /Earlier comment/,
        "loaded comments survive failed refresh"
      );
      assert.equal($("activity-error").hidden, false);
      const beforeRetry = posts().length;
      await click('[data-action="retry-activity"] button');
      assert.equal(
        posts().length,
        beforeRetry,
        "refresh retry must not repeat an acknowledged comment"
      );
      assert.match($("activity").textContent, /First line\nSecond line/);
      assert.equal($("comment-error").hidden, true);
      assert.equal($("activity-error").hidden, true);
      assert.equal(document.activeElement, $("comment"));
      entries.length = 0;
      await click('[data-action="retry-activity"] button');
      assert.equal(
        $("activity-empty").hidden,
        false,
        "a successful empty read has the legacy empty state"
      );
      assert.equal($("activity").textContent, "");
      // Switching task clears the prior activity, while returning to a dirty editor remains guarded.
      await click('[data-action="close-editor"] button');
      assert.equal($("discard-draft").hidden, true);
      assert.equal($("editor").hidden, true);
      task.id = "two";
      task.title = "Other task";
      globalThis.__tasksActivity.request = async (method, path) => {
        if (path === "/tasks/two") return { task };
        if (path.endsWith("/activity")) throw new Error("other read failed");
        if (path.endsWith("/subtasks")) return { tasks: [] };
        if (path.endsWith("/tags")) return { tags: [] };
        throw new Error(`Unexpected ${method} ${path}`);
      };
      await click("#task-results .jds-btn");
      assert.equal(
        $("activity").textContent,
        "",
        "another task must not inherit the previous activity"
      );
      assert.equal(
        $("activity-empty").hidden,
        true,
        "a failed read is not an empty activity history"
      );
    } finally {
      delete globalThis.__tasksActivity;
      for (const key of keys) {
        if (old[key] === undefined) delete globalThis[key];
        else globalThis[key] = old[key];
      }
      dom.window.close();
    }
  }
);
