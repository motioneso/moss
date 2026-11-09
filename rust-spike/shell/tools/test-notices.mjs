import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../connect/assets/notices.js", import.meta.url), "utf8");

async function client() {
  let tick;
  const sent = [];
  const state = {
    account: "first",
    events: ["old"],
    messages: [{ id: "old", role: "assistant" }],
    status: 200,
    focused: false
  };
  const context = {
    document: { hidden: false, hasFocus: () => state.focused },
    window: { ipc: { postMessage: (s) => sent.push(JSON.parse(s)) } },
    fetch: async (path) => ({
      ok: state.status === 200,
      status: state.status,
      json: async () =>
        path.includes("notices")
          ? { account: state.account, events: state.events }
          : { messages: state.messages }
    }),
    setInterval: (callback) => {
      tick = callback;
    }
  };
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  return { state, sent, tick };
}

test("initial unread items are quiet; new reminders and replies notify once", async () => {
  const { state, sent, tick } = await client();
  assert.deepEqual(sent, []);
  state.events.push("new");
  state.messages.push({ id: "new", role: "assistant" });
  await tick();
  assert.deepEqual(sent, [{ notice: "reminder" }, { notice: "chat" }]);
  await tick();
  assert.equal(sent.length, 2);
});

test("focus suppresses banners; switching accounts and signing out reset baselines", async () => {
  const { state, sent, tick } = await client();
  state.focused = true;
  state.events.push("focused");
  await tick();
  state.focused = false;
  await tick();
  assert.equal(sent.length, 0);
  state.account = "second";
  state.events = ["other"];
  state.messages = [{ id: "other", role: "assistant" }];
  await tick();
  assert.equal(sent.length, 0);
  state.status = 401;
  await tick();
  state.status = 200;
  state.events.push("while-signed-out");
  await tick();
  assert.equal(sent.length, 0);
});
