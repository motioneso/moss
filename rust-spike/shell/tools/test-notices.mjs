import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../connect/assets/notices.js", import.meta.url), "utf8");

async function client(storage = new Map(), initial = {}) {
  let tick;
  const sent = [];
  const state = {
    account: "first",
    events: ["old"],
    messages: [{ id: "old", role: "assistant" }],
    status: 200,
    focused: false,
    storageFails: false,
    ...initial
  };
  const window = { ipc: { postMessage: (s) => sent.push(JSON.parse(s)) } };
  const context = {
    crypto: { randomUUID: () => Math.random().toString() },
    document: { hidden: false, hasFocus: () => state.focused },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (state.storageFails) throw new Error("Storage unavailable");
        storage.set(key, value);
      }
    },
    window,
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
  return { state, sent, tick, ack: (message) => window.mossNoticeAck(message.receipt) };
}

const kinds = (sent) => sent.map((message) => message.notice);

test("initial unread items are quiet; accepted reminders and replies notify once", async () => {
  const { state, sent, tick, ack } = await client();
  assert.deepEqual(sent, []);
  state.events.push("new");
  state.messages.push({ id: "new", role: "assistant" });
  await tick();
  assert.deepEqual(kinds(sent), ["reminder", "chat"]);
  sent.forEach(ack);
  await tick();
  assert.equal(sent.length, 2);
});

test("missing native acceptance retries instead of losing the new notice", async () => {
  const { state, sent, tick, ack } = await client();
  state.events.push("retry");
  await tick();
  await tick();
  assert.deepEqual(kinds(sent), ["reminder", "reminder"]);
  ack(sent[0]); // An expired attempt cannot acknowledge a newer attempt.
  await tick();
  assert.equal(sent.length, 3);
  ack(sent[2]);
  await tick();
  assert.equal(sent.length, 3);
});

test("pending and accepted receipts survive a fresh document in the same profile", async () => {
  const storage = new Map();
  const first = await client(storage);
  first.state.events.push("pending");
  await first.tick();
  const second = await client(storage, { events: ["old", "pending", "while-away"] });
  assert.deepEqual(kinds(second.sent), ["reminder"]);
  second.ack(second.sent[0]);
  const third = await client(storage, { events: ["old", "pending", "while-away"] });
  assert.deepEqual(third.sent, []);
  assert(![...storage.values()].join().includes("receipt")); // No document tokens are saved.
});

test("focus consumes notices without banners; receipts do not mark bell items read", async () => {
  const { state, sent, tick } = await client();
  state.focused = true;
  state.events.push("focused");
  await tick();
  state.focused = false;
  await tick();
  assert.equal(sent.length, 0);
  assert.deepEqual(state.events, ["old", "focused"]);
});

test("accounts and server profiles have independent baselines and receipts", async () => {
  const storage = new Map();
  const first = await client(storage);
  first.state.events.push("pending");
  await first.tick();
  first.state.account = "second";
  first.state.events = ["other"];
  await first.tick();
  first.ack(first.sent[0]); // Late acknowledgement from the previous account is ignored.
  first.state.events.push("new-other");
  await first.tick();
  first.ack(first.sent[1]);
  first.state.account = "first";
  first.state.events = ["old", "pending"];
  await first.tick();
  assert.equal(first.sent.length, 3);
  const separateServer = await client(new Map(), { events: ["old", "pending"] });
  assert.equal(separateServer.sent.length, 0);
});

test("sign-out invalidates in-flight acceptance but preserves pending receipts", async () => {
  const { state, sent, tick, ack } = await client();
  state.events.push("pending");
  await tick();
  state.status = 401;
  await tick();
  ack(sent[0]);
  state.status = 200;
  await tick();
  assert.equal(sent.length, 2);
  ack(sent[1]);
  await tick();
  assert.equal(sent.length, 2);
});

test("storage failures never advance delivery; failed acceptance writes retry", async () => {
  const { state, sent, tick, ack } = await client();
  state.events.push("retry");
  state.storageFails = true;
  await tick();
  assert.equal(sent.length, 0);
  state.storageFails = false;
  await tick();
  state.storageFails = true;
  ack(sent[0]);
  state.storageFails = false;
  await tick();
  assert.equal(sent.length, 2);
  ack(sent[1]);
  await tick();
  assert.equal(sent.length, 2);
});

test("read or removed notifications are not retried, and old chat history stays quiet", async () => {
  const first = await client();
  first.state.events.push("pending");
  await first.tick();
  first.state.events = ["old"];
  await first.tick();
  assert.equal(first.sent.length, 1);
  const history = Array.from({ length: 1200 }, (_, id) => ({ id: String(id), role: "assistant" }));
  const second = await client(new Map(), { messages: history });
  await second.tick();
  assert.equal(second.sent.length, 0);
  second.state.messages.push({ id: "new", role: "assistant" });
  await second.tick();
  assert.deepEqual(kinds(second.sent), ["chat"]);
});

test("malformed saved receipts are retained and do not produce an alert flood", async () => {
  const storage = new Map([["moss.desktop.receipts.v1:first", "broken"]]);
  const { sent, tick } = await client(storage);
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(storage.get("moss.desktop.receipts.v1:first"), "broken");
});
