import { test } from "node:test";
import assert from "node:assert/strict";
import { connectModuleFrame } from "./host-bridge.mjs";
import { moduleClient } from "./guest-bridge.mjs";
function setup() {
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
    request: (...args) => {
      calls.push(args);
      return { saved: true };
    },
    theme: () => ({ theme: "sage" }),
    navigate: () => null,
    chat: () => null
  });
  const commandPort = { postMessage() {}, start() {}, close() {} };
  const bootstrap = (origin = "null", from = source, port = commandPort) =>
    listener({
      source: from,
      origin,
      data: { channel: "moss.module.v1", type: "connect" },
      ports: [port]
    });
  bootstrap("https://moss.example.test");
  bootstrap("null", {});
  assert.equal(commandPort.onmessage, undefined);
  bootstrap();
  frame.dispatchEvent(new Event("load"));
  const send = (message) =>
    commandPort.onmessage({
      ports: [{ postMessage: (m) => replies.push(m), close() {} }],
      data: { channel: "moss.module.v1", id: "one", ...message }
    });
  return { send, replies, calls, frame, dispose, bootstrap };
}
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
      parent: {
        postMessage(message, target, ports) {
          assert.equal(target, "*");
          assert.equal(message.type, "connect");
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
    crypto: { randomUUID: () => token },
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
