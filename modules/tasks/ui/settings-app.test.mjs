/* global document, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test(
  "task settings keep confirmed choices and recover independently of tasks",
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
    let enabled = true;
    let failRead = true;
    let failWrite = false;
    let release;
    globalThis.__tasksSettings = {
      theme: async () => ({}),
      resize: async () => {},
      dispose() {},
      async request(method, path, body) {
        calls.push({ method, path, body });
        if (path === "/tasks") return { tasks: [] };
        if (path === "/tasks/lists") return { lists: [] };
        if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
        assert.equal(path, "/tasks/agency-auto-execute");
        if (method === "GET") {
          if (failRead) throw new Error("offline read");
          return { enabled };
        }
        if (release)
          await new Promise((resolve) => {
            release = resolve;
          });
        if (failWrite) throw new Error("offline write");
        enabled = body.enabled;
        return { enabled };
      }
    };
    const settled = async () => {
      for (let i = 0; i < 100; i++) {
        if (!$("tasks-app").hasAttribute("aria-busy")) return;
        await delay(5);
      }
      assert.fail("settings action did not settle");
    };
    const reload = async () => {
      $("retry-task-settings").querySelector("button").click();
      await settled();
    };
    const toggle = () => $("assistant-auto-execute");
    const writes = () => calls.filter((c) => c.method === "PATCH");
    try {
      let source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
      source = source.replace(
        'import { moduleClient } from "./guest-bridge.mjs";',
        "const moduleClient = () => globalThis.__tasksSettings;"
      );
      source = source.replaceAll(
        /from "(\.\/.+?\.mjs)"/g,
        (_match, path) => `from "${new URL(path, import.meta.url).href}"`
      );
      await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      await settled();
      assert.equal($("overview").hidden, false);
      assert.equal(toggle().disabled, true);
      assert.equal(
        calls.some((c) => c.path.endsWith("auto-execute")),
        false
      );
      $("task-settings").open = true;
      // Dispatch explicitly; jsdom also queues its native toggle event.
      $("task-settings").dispatchEvent(new window.Event("toggle"));
      await delay(5);
      await settled();
      assert.equal($("task-settings-load-error").hidden, false);
      assert.match($("task-settings-load-message").textContent, /unavailable/);
      assert.equal(toggle().disabled, true, "failed initial load must not enable saving a default");
      assert.equal(writes().length, 0);
      assert.equal($("overview").hidden, false, "settings failures must not hide tasks");
      failRead = false;
      await reload();
      assert.equal(toggle().checked, true);
      assert.equal(toggle().disabled, false);
      assert.equal($("task-settings-load-error").hidden, true);
      failWrite = true;
      toggle().click();
      await settled();
      assert.equal(writes().length, 1);
      assert.deepEqual(writes()[0].body, { enabled: false });
      assert.equal(toggle().checked, true, "failed save restores the confirmed value");
      assert.equal($("task-settings-save-error").hidden, false);
      failWrite = false;
      release = true;
      toggle().click();
      assert.equal(toggle().disabled, true);
      toggle().click();
      assert.equal(writes().length, 2, "pending saves cannot double-submit");
      release();
      release = null;
      await settled();
      assert.equal(enabled, false);
      assert.equal(toggle().checked, false);
      assert.equal($("task-settings-save-error").hidden, true);
      assert.equal($("task-settings-saved").hidden, false);
      failRead = true;
      await reload();
      assert.equal(toggle().checked, false);
      assert.equal(toggle().disabled, false);
      assert.match($("task-settings-load-message").textContent, /last saved/);
      failRead = false;
      enabled = true;
      await reload();
      assert.equal(
        toggle().checked,
        true,
        "refresh shows the server value, including other sessions"
      );
      assert.equal(writes().length, 2, "refresh retries must never write");
      assert.match($("task-settings-limit").textContent, /still ask for approval/);
    } finally {
      dom.window.close();
      for (const key of keys) {
        if (old[key] === undefined) delete globalThis[key];
        else globalThis[key] = old[key];
      }
      delete globalThis.__tasksSettings;
    }
  }
);
