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
    now: 0,
    acceptanceFails: false,
    accepted: new Map(),
    posts: [],
    legacyServer: false,
    ...initial
  };
  const background = [];
  // Only receipt requests count as notices; heartbeat and enrolment go to `background`.
  const window = {
    ipc: {
      postMessage: (s) => {
        const message = JSON.parse(s);
        (message.notice ? sent : background).push(message);
      }
    }
  };
  const context = {
    crypto: {
      randomUUID: () =>
        "00000000-0000-4000-8000-" +
        Math.floor(Math.random() * 2 ** 48)
          .toString(16)
          .padStart(12, "0"),
      getRandomValues: (values) => values.map(() => Math.floor(Math.random() * 2 ** 32))
    },
    Date: { now: () => state.now },
    document: { hidden: false, hasFocus: () => state.focused },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (state.storageFails) throw new Error("Storage unavailable");
        storage.set(key, value);
      }
    },
    window,
    fetch: async (path, options = {}) => {
      if (path === "/api/desktop/notifier") {
        return { ok: true, status: 200, json: async () => ({ token: "t".repeat(64) }) };
      }
      const key =
        state.account +
        ":" +
        (path.includes("?client=")
          ? path.split("?client=")[1]
          : JSON.parse(options.body || "{}").client);
      if (options.method === "POST") {
        state.posts.push(JSON.parse(options.body));
        if (!state.acceptanceFails && state.status === 200) {
          const ids = new Set(state.accepted.get(key) || []);
          for (const id of JSON.parse(options.body).events) ids.add(id);
          state.accepted.set(key, [...ids]);
        }
      }
      return {
        ok: state.status === 200 && !(options.method === "POST" && state.acceptanceFails),
        status: state.status,
        json: async () =>
          path.includes("notices")
            ? {
                account: state.account,
                events: state.events,
                acknowledged: state.legacyServer ? undefined : state.accepted.get(key) || []
              }
            : { messages: state.messages }
      };
    },
    setInterval: (callback) => {
      tick = callback;
    }
  };
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  return {
    state,
    sent,
    background,
    tick: async (elapsed = 5000) => {
      state.now += elapsed;
      await tick();
    },
    ack: (message) => window.mossNoticeAck(message.receipt)
  };
}

const kinds = (sent) => sent.map((message) => message.notice);

test("older servers keep local acceptance without retrying an unsupported write", async () => {
  const { state, sent, tick, ack } = await client(new Map(), { legacyServer: true });
  state.events.push("legacy");
  await tick();
  await ack(sent[0]);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(state.posts.length, 0);
});

test("initial unread items are quiet; accepted reminders and replies notify once", async () => {
  const { state, sent, tick, ack } = await client();
  assert.deepEqual(sent, []);
  state.events.push("new");
  state.messages.push({ id: "new", role: "assistant" });
  await tick();
  assert.deepEqual(kinds(sent), ["reminder", "chat"]);
  await Promise.all(sent.map(ack));
  await tick();
  assert.equal(sent.length, 2);
});

test("missing native acceptance retries instead of losing the new notice", async () => {
  const { state, sent, tick, ack } = await client();
  state.events.push("retry");
  await tick();
  await tick();
  assert.deepEqual(kinds(sent), ["reminder", "reminder"]);
  await ack(sent[0]); // An expired attempt cannot acknowledge a newer attempt.
  await tick(10000);
  assert.equal(sent.length, 3);
  await ack(sent[2]);
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
  await second.ack(second.sent[0]);
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
  await first.ack(first.sent[0]); // Late acknowledgement from the previous account is ignored.
  first.state.events.push("new-other");
  await first.tick();
  await first.ack(first.sent[1]);
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
  await ack(sent[0]);
  state.status = 200;
  await tick();
  assert.equal(sent.length, 2);
  await ack(sent[1]);
  await tick();
  assert.equal(sent.length, 2);
});

test("storage failures pause delivery; server acceptance survives a failed local write", async () => {
  const { state, sent, tick, ack } = await client();
  state.events.push("retry");
  state.storageFails = true;
  await tick();
  assert.equal(sent.length, 0);
  state.storageFails = false;
  await tick();
  state.storageFails = true;
  await ack(sent[0]);
  state.storageFails = false;
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(state.posts.length, 1);
  await tick();
  assert.equal(sent.length, 1);
});

test("failed server acceptance keeps delivery pending until a durable retry", async () => {
  const { state, sent, tick, ack } = await client();
  state.events.push("retry");
  await tick();
  state.acceptanceFails = true;
  await ack(sent[0]);
  await tick();
  assert.equal(sent.length, 2);
  state.acceptanceFails = false;
  await ack(sent[1]);
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(state.posts[0].events, ["retry"]);
  assert.deepEqual(state.posts[1].events, ["retry"]);
});

test("server acceptance suppresses restored pending receipts only for the same client", async () => {
  const storage = new Map();
  const first = await client(storage);
  first.state.events.push("pending");
  await first.tick();
  const backup = new Map(storage);
  await first.ack(first.sent[0]);
  const resumed = await client(new Map(backup), {
    events: ["old", "pending"],
    accepted: first.state.accepted
  });
  assert.equal(resumed.sent.length, 0);
  backup.delete("moss.desktop.client.v1");
  const other = await client(backup, {
    events: ["old", "pending"],
    accepted: first.state.accepted
  });
  assert.deepEqual(kinds(other.sent), ["reminder"]);
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

test("a still-unread ID stays known when recent history fills up", async () => {
  const known = Array.from({ length: 1000 }, (_, id) => String(id));
  const storage = new Map([
    [
      "moss.desktop.receipts.v1:first",
      JSON.stringify({
        reminder: { known, pending: [] },
        chat: { known: null, pending: [] }
      })
    ]
  ]);
  const { sent, tick, ack } = await client(storage, { events: ["0", "999", "new"] });
  assert.deepEqual(kinds(sent), ["reminder"]);
  await ack(sent[0]);
  await tick();
  assert.equal(sent.length, 1);
});

test("missing acceptance backs off retries to at most once a minute", async () => {
  const { state, sent, tick } = await client();
  state.events.push("pending");
  await tick();
  await tick();
  assert.equal(sent.length, 2);
  await tick();
  assert.equal(sent.length, 2);
  await tick();
  assert.equal(sent.length, 3);
  await tick(20000);
  assert.equal(sent.length, 4);
  await tick(40000);
  assert.equal(sent.length, 5);
  await tick(55000);
  assert.equal(sent.length, 5);
  await tick();
  assert.equal(sent.length, 6);
});

test("each poll sends a heartbeat and the notifier is enrolled once per account", async () => {
  const { background, tick } = await client(new Map(), {});
  await tick();
  assert.equal(background.filter((m) => m.heartbeat).length, 2);
  assert.equal(background.filter((m) => m.token).length, 1);
});
