import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { connectModuleFrame } from "./host-bridge.mjs";
import { moduleClient } from "./guest-bridge.mjs";
function setup({
  loadsBeforeConnect = 0,
  request = () => ({ saved: true }),
  keyed = true,
  connect = true
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
    theme: () => ({ theme: "sage" }),
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
  const client = moduleClient({
    guestWindow: {
      parent: {
        postMessage(_, __, ports) {
          transport = ports[0];
          transport.onmessage = (event) => {
            port = event.ports[0];
          };
        }
      }
    },
    timeoutMs: 5
  });
  await assert.rejects(client.theme(), /Moss did not reply/);
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
