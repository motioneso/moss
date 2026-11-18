/* global document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

async function mount(theme) {
  const html = execFileSync(process.env.TASKS_SCREEN_BIN, ["--screen"], { encoding: "utf8" });
  const dom = new JSDOM(html, { url: "https://tasks.example.test" });
  const keys = ["document", "window", "Option", "FormData"];
  const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  for (const key of keys) globalThis[key] = dom.window[key];
  const task = {
    id: "t1",
    title: "Reply to Sam",
    status: "todo",
    source: "email",
    description: null,
    priority: null,
    effort: null,
    dueAt: null,
    doAt: null,
    recurrence: null,
    parentTaskId: null,
    tags: [],
    listId: "l1"
  };
  globalThis.__tasksNames = {
    theme: async () => theme,
    resize: async () => {},
    dispose() {},
    async request(_method, path) {
      if (path === "/tasks") return { tasks: [task] };
      if (path === "/tasks/lists") return { lists: [{ id: "l1", name: "Inbox" }] };
      if (path === "/tasks/local-day") return { timezone: "UTC", date: "2026-11-10" };
      if (path === "/tasks/preferences") return { preferences: { defaultView: "priority" } };
      if (path.endsWith("auto-execute")) return { enabled: false };
      return {};
    }
  };
  let source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
  source = source.replace(
    'import { moduleClient } from "./guest-bridge.mjs";',
    "const moduleClient = () => globalThis.__tasksNames;"
  );
  source = source.replaceAll(
    /from "(\.\/.+?\.mjs)"/g,
    (_match, path) => `from "${new URL(path, import.meta.url).href}"`
  );
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await delay(100);
  const text = (id) => document.getElementById(id).textContent;
  const result = { assignee: text("task-assignee"), note: text("tracking-note") };
  dom.window.close();
  for (const key of keys) {
    if (old[key] === undefined) delete globalThis[key];
    else globalThis[key] = old[key];
  }
  delete globalThis.__tasksNames;
  return result;
}

test(
  "the screen shows the account name and the saved assistant name",
  { skip: !process.env.TASKS_SCREEN_BIN },
  async () => {
    const seen = await mount({ displayName: "Ben", assistantName: "Jarvis" });
    assert.equal(seen.assignee, "Ben · you");
    assert.match(seen.note, /^Jarvis is tracking 1 task /);
  }
);
