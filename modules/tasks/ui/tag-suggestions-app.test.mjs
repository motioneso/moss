/* global document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "real screen loads list suggestions, retries failures and reuses typed existing tags",
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
    const calls = [];
    let fail = true;
    let parent = null;
    const tags = [
      { id: "literal", name: "#literal" },
      { id: "work", name: "WORK" },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: `tag${i}` }))
    ];
    const bridgeKey = "__tasksTagSuggestions";
    globalThis[bridgeKey] = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        calls.push({ method, path, body });
        if (path === "/tasks" && method === "GET") return { tasks: parent ? [parent] : [] };
        if (path === "/tasks/lists")
          return {
            lists: [
              { id: "a", name: "Inbox" },
              { id: "b", name: "Home" }
            ]
          };
        if (path === "/tasks/local-day") return { timezone: "UTC", date: "2026-11-09" };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        if (path === "/tasks/lists/a/tags" && method === "GET") {
          if (fail) throw new Error("connection unavailable");
          return { tags };
        }
        if (path === "/tasks/lists/b/tags" && method === "GET")
          return { tags: [{ id: "home", name: "home" }] };
        if (path === "/tasks" && method === "POST") {
          parent = { ...body, id: "p", parentTaskId: null, tags: [] };
          return { task: parent };
        }
        if (path === "/tasks/p/tags") {
          parent.tags.push(tags.find((tag) => tag.id === body.tagId));
          return {};
        }
        if (path === "/tasks/p/subtasks") return { tasks: [] };
        if (path === "/tasks/p/activity") return { activity: [] };
        if (path === "/tasks/p") return { task: parent };
        throw new Error(`Unexpected request ${method} ${path}`);
      }
    };
    const $ = (id) => document.getElementById(id);
    async function settled() {
      for (let i = 0; i < 100; i++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("screen did not settle");
    }
    try {
      const source = readFileSync(
        process.env.TASKS_TAG_APP_SOURCE || new URL("./app.mjs", import.meta.url),
        "utf8"
      )
        .replace(
          'import { moduleClient } from "./guest-bridge.mjs";',
          `const moduleClient = () => globalThis.${bridgeKey};`
        )
        .replaceAll(
          /from "(\.\/.+?\.mjs)"/g,
          (_match, path) => `from "${new URL(path, import.meta.url).href}"`
        );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settled();
      document.querySelector('[data-action="new"] button').click();
      await settled();
      assert.equal($("new-tags-error").hidden, false);
      $("title").value = "Keep my draft";
      fail = false;
      document.querySelector('[data-action="retry-new-tags"] button').click();
      await settled();
      assert.equal($("new-tags-error").hidden, true);
      assert.equal($("title").value, "Keep my draft");
      assert.equal($("new-tag-suggestions").children.length, 8);
      $("new-tag-suggestions").querySelector("button").click();
      await settled();
      assert.equal($("new-tags").textContent, "Remove ##literal");
      assert.doesNotMatch($("new-tag-suggestions").textContent, /literal/);
      assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
      $("task-list").value = "b";
      $("task-list").dispatchEvent(new dom.window.Event("change"));
      await settled();
      assert.equal($("new-tag-suggestions").textContent, "Add #home");
      assert.equal($("new-tags").textContent, "Remove ##literal", "list switches keep draft tags");
      $("task-list").value = "a";
      $("task-list").dispatchEvent(new dom.window.Event("change"));
      await settled();
      $("task-form").querySelector('button[type="submit"]').click();
      await settled();
      assert.equal(parent.tags[0].id, "literal");
      assert.equal(
        calls.filter((call) => call.method === "POST" && call.path === "/tasks/lists/a/tags")
          .length,
        0
      );
      [...$("task-results").querySelectorAll("button")]
        .find((node) => node.textContent === "Keep my draft")
        .click();
      await settled();
      $("tag-name").value = "#work";
      $("tag-form").querySelector('button[type="submit"]').click();
      await settled();
      assert.equal($("edit-error").hidden, true);
      assert.deepEqual(
        parent.tags.map((tag) => tag.id),
        ["literal", "work"]
      );
      assert.equal(
        calls.filter((call) => call.method === "POST" && call.path === "/tasks/lists/a/tags")
          .length,
        0
      );
    } finally {
      delete globalThis[bridgeKey];
      for (const [key, value] of Object.entries(old)) globalThis[key] = value;
      dom.window.close();
    }
  }
);
