import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { connectModuleFrame } from "./host-bridge.mjs";
import { moduleClient } from "./guest-bridge.mjs";
function setup({
  loadsBeforeConnect = 0,
  request = () => ({ saved: true }),
  keyed = true,
  connect = true,
  theme = () => ({ theme: "sage" })
} = {}) {
  let listener;
  const replies = [];
  const calls = [];
  const source = { postMessage: (m) => replies.push(m) };
  const frame = new EventTarget();
  Object.assign(frame, { contentWindow: source, style: {} });
  const hostWindow = {
    addEventListener: (_, fn) => {
      listener = fn;
    },
    removeEventListener() {}
  };
  const dispose = connectModuleFrame(frame, "sample.counter", {
    hostWindow,
    ...(keyed ? { screenUrl: "/module-ui/sample.counter/digest/ui/index.html" } : {}),
    request: (...args) => {
      calls.push(args);
      return request(...args);
    },
    theme,
    navigate: () => null,
    chat: () => null
  });
  const commandPort = { postMessage() {}, start() {}, close() {} };
  const documentKey = new URLSearchParams(
    new URL(frame.src ?? "/", "https://moss.invalid").hash.slice(1)
  ).get("moss-frame");
  const bootstrap = (origin = "null", from = source, port = commandPort, key = documentKey) =>
    listener({
      source: from,
      origin,
      data: { channel: "moss.module.v1", type: "connect", documentKey: key },
      ports: [port]
    });
  bootstrap("https://moss.example.test");
  bootstrap("null", {});
  if (keyed) bootstrap("null", source, commandPort, "different-document");
  assert.equal(commandPort.onmessage, undefined);
  for (let i = 0; i < loadsBeforeConnect; i++) frame.dispatchEvent(new Event("load"));
  if (connect) bootstrap();
  if (loadsBeforeConnect === 0) frame.dispatchEvent(new Event("load"));
  const send = (message) =>
    commandPort.onmessage?.({
      ports: [{ postMessage: (m) => replies.push(m), close() {} }],
      data: { channel: "moss.module.v1", id: "one", ...message }
    });
  return { send, replies, calls, frame, dispose, bootstrap };
}
test("an async theme callback replies with its value, not a promise", async () => {
  const s = setup({ theme: async () => ({ theme: "sage", displayName: "Ben" }) });
  s.send({ type: "theme" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(s.replies.at(-1), {
    channel: "moss.module.v1",
    id: "one",
    ok: true,
    result: { theme: "sage", displayName: "Ben" }
  });
});
test("initial frame load before the queued connect message still permits requests", async () => {
  const s = setup({ loadsBeforeConnect: 1 });
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.deepEqual(s.calls, [["GET", "/api/m/sample.counter/entries", null]]);
  assert.equal(s.replies[0].ok, true);
  s.frame.dispatchEvent(new Event("load"));
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 1);
  s.dispose();
});
test("navigation before any connect message revokes a still-unconnected bridge", async () => {
  const s = setup({ loadsBeforeConnect: 2 });
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 0);
  assert.equal(s.replies.length, 0);
  s.dispose();
});
test("a late connect from a different document cannot claim the waiting bridge", async () => {
  const s = setup({ loadsBeforeConnect: 1, connect: false });
  for (const key of [undefined, null, "different-document"])
    s.bootstrap("null", s.frame.contentWindow, undefined, key === undefined ? "" : key);
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 0);
  s.bootstrap();
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 1);
  s.dispose();
});
test("unkeyed legacy callers still refuse a connection after initial load", async () => {
  const s = setup({ loadsBeforeConnect: 1, keyed: false });
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 0);
  s.dispose();
});
test("navigation discards a response still waiting on the host", async () => {
  let finish;
  const s = setup({
    loadsBeforeConnect: 1,
    request: () => new Promise((resolve) => (finish = resolve))
  });
  const pending = s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 1);
  s.frame.dispatchEvent(new Event("load"));
  finish({ saved: true });
  await pending;
  assert.equal(s.replies.length, 0);
  s.dispose();
});
test("only the bound opaque frame can invoke own-module routes", async () => {
  const s = setup();
  assert.equal(s.calls.length, 0);
  await s.send({ type: "request", method: "GET", path: "/entries?tag=one" });
  assert.deepEqual(s.calls, [["GET", "/api/m/sample.counter/entries?tag=one", null]]);
  assert.equal(s.replies[0].ok, true);
  for (const path of ["//evil.test", "/../../people", "/%2e%2e/%2e%2e/people", "/x\\y"])
    await s.send({ type: "request", method: "GET", path });
  assert.equal(s.calls.length, 1);
  s.dispose();
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 1);
});
test("resize is bounded and errors do not forward host diagnostics", async () => {
  const s = setup();
  await s.send({ type: "resize", height: 1 });
  assert.equal(s.frame.style.height, "160px");
  await s.send({ type: "unknown" });
  assert.equal(s.replies.at(-1).error, "Moss could not finish this request");
});
test("guest receives replies only on its document-bound port and disposes pending work", async () => {
  let receive;
  let transport;
  const next = () =>
    new Promise((resolve) => {
      receive = resolve;
    });
  const client = moduleClient({
    guestWindow: {
      location: { hash: "#moss-frame=fixture-document-key" },
      parent: {
        postMessage(message, target, ports) {
          assert.equal(target, "*");
          assert.equal(message.type, "connect");
          assert.equal(message.documentKey, "fixture-document-key");
          transport = ports[0];
          transport.onmessage = ({ data, ports: replies }) =>
            receive({ message: data, port: replies[0] });
        }
      }
    },
    timeoutMs: 1000
  });
  const first = next();
  const result = client.request("GET", "/entries");
  let sent = await first;
  sent.port.postMessage({ channel: "moss.module.v1", id: "wrong", ok: true, result: "wrong" });
  sent.port.postMessage({
    channel: "moss.module.v1",
    id: sent.message.id,
    ok: true,
    result: [{ title: "Own entry" }]
  });
  assert.deepEqual(await result, [{ title: "Own entry" }]);
  sent.port.close();
  const second = next();
  const pending = client.theme();
  sent = await second;
  const rejected = assert.rejects(pending, /Module closed/);
  client.dispose();
  await rejected;
  sent.port.close();
  await assert.rejects(client.theme(), /Module closed or busy/);
  transport.close();
});
test("guest times out a parent which never replies", async () => {
  let port;
  let transport;
  let received;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  const client = moduleClient({
    guestWindow: {
      parent: {
        postMessage(_, __, ports) {
          transport = ports[0];
          transport.onmessage = (event) => {
            port = event.ports[0];
            received();
          };
        }
      }
    },
    timeoutMs: 5
  });
  const rejected = assert.rejects(client.theme(), /Moss did not reply/);
  await arrived;
  await rejected;
  client.dispose();
  port.close();
  transport.close();
});

test("a newly loaded document cannot invoke routes on the old frame bridge", async () => {
  const s = setup();
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 1);
  // The newly navigating document tries to bootstrap before its load event.
  const replacement = {
    postMessage() {},
    start() {
      throw new Error("new document accepted");
    }
  };
  s.bootstrap("null", s.frame.contentWindow, replacement);
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 2); // the old document port still belongs to the old document
  s.frame.dispatchEvent(new Event("load"));
  await s.send({ type: "request", method: "GET", path: "/entries" });
  assert.equal(s.calls.length, 2);
  assert.equal(s.replies.length, 2);
  s.dispose();
});

test("keyed screens work without the secure-context-only UUID API", async () => {
  const uuid = mock.method(globalThis.crypto, "randomUUID", () => {
    throw new Error("UUID API unavailable outside a secure context");
  });
  try {
    const s = setup();
    await s.send({ type: "request", method: "GET", path: "/entries" });
    assert.equal(s.calls.length, 1);
    s.dispose();
  } finally {
    uuid.mock.restore();
  }
});

test("screen URLs must remain inside their verified module path after normalization", () => {
  for (const screenUrl of [
    "/module-ui/sample.counter/../other/ui/index.html",
    "/module-ui/sample.counter/%2e%2e/other/ui/index.html",
    "/module-ui/sample.counter/digest/ui/index.html?redirect=other",
    "https://other.example/module-ui/sample.counter/digest/ui/index.html"
  ])
    assert.throws(
      () => connectModuleFrame(new EventTarget(), "sample.counter", { screenUrl }),
      /Invalid screen URL/
    );
});

test("fresh verified-screen token accepts queued initial bootstrap after load, never a replacement", async () => {
  const { openModuleFrame } = await import("./host-bridge.mjs");
  let receive;
  const token = "0123456789abcdef0123456789abcdef";
  const frame = new EventTarget();
  frame.contentWindow = {};
  frame.style = {};
  let calls = 0;
  const hostWindow = {
    location: new URL("https://moss.example.test/calendar"),
    crypto: {
      // Non-secure LAN origins expose getRandomValues, but not randomUUID.
      getRandomValues(bytes) {
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = parseInt(token.slice(i * 2, i * 2 + 2), 16);
        return bytes;
      }
    },
    addEventListener(_, fn) {
      receive = fn;
    },
    removeEventListener() {}
  };
  const callbacks = {
    hostWindow,
    request: () => {
      calls++;
      return null;
    },
    theme: () => null,
    navigate: () => null,
    chat: () => null
  };
  assert.throws(() =>
    openModuleFrame(
      frame,
      "calendar",
      "https://evil.test/module-ui/calendar/x/ui/index.html",
      callbacks
    )
  );
  openModuleFrame(frame, "calendar", "/module-ui/calendar/digest/ui/index.html", callbacks);
  assert.equal(new URL(frame.src).hash, "#moss-bootstrap=" + token);
  frame.dispatchEvent(new Event("load"));
  const port = { postMessage() {}, start() {}, close() {} };
  const connect = (value, candidate = port) =>
    receive({
      source: frame.contentWindow,
      origin: "null",
      data: { channel: "moss.module.v1", type: "connect", bootstrapToken: value },
      ports: [candidate]
    });
  connect(undefined);
  connect("wrong");
  assert.equal(port.onmessage, undefined);
  connect(token);
  assert.equal(typeof port.onmessage, "function");
  const send = () =>
    port.onmessage({
      data: {
        channel: "moss.module.v1",
        id: "one",
        type: "request",
        method: "GET",
        path: "/events"
      },
      ports: [{ postMessage() {}, close() {} }]
    });
  await send();
  assert.equal(calls, 1);
  const replacement = {
    start() {
      throw new Error("replacement bootstrap accepted");
    },
    close() {}
  };
  connect(token, replacement);
  frame.dispatchEvent(new Event("load"));
  await send();
  assert.equal(calls, 1);
  connect(token, replacement);
  assert.equal(replacement.onmessage, undefined);
});

test("guest echoes only its initial document fragment token", () => {
  let message, transport;
  const client = moduleClient({
    guestWindow: {
      location: { hash: "#moss-bootstrap=0123456789abcdef0123456789abcdef" },
      parent: {
        postMessage(value, _, ports) {
          message = value;
          transport = ports[0];
        }
      }
    }
  });
  assert.equal(message.bootstrapToken, "0123456789abcdef0123456789abcdef");
  client.dispose();
  transport.close();
});
