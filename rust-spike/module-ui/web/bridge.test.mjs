import { test } from "node:test";
import assert from "node:assert/strict";
import { connectModuleFrame } from "./host-bridge.mjs";
import { moduleClient } from "./guest-bridge.mjs";
function setup() {
  let listener;
  const replies = [];
  const calls = [];
  const source = { postMessage: (m) => replies.push(m) };
  const frame = { contentWindow: source, style: {} };
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
  const send = (message, origin = "null", from = source) =>
    listener({
      source: from,
      origin,
      ports: [{ postMessage: (m) => replies.push(m), close() {} }],
      data: { channel: "moss.module.v1", id: "one", ...message }
    });
  return { send, replies, calls, frame, dispose };
}
test("only the bound opaque frame can invoke own-module routes", async () => {
  const s = setup();
  await s.send({ type: "request", method: "GET", path: "/entries" }, "https://moss.example.test");
  await s.send({ type: "request", method: "GET", path: "/entries" }, "null", {});
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
  let sent;
  const client = moduleClient({
    guestWindow: {
      parent: {
        postMessage(message, target, ports) {
          assert.equal(target, "*");
          sent = { message, port: ports[0] };
        }
      }
    },
    timeoutMs: 1000
  });
  const result = client.request("GET", "/entries");
  sent.port.postMessage({ channel: "moss.module.v1", id: "wrong", ok: true, result: "wrong" });
  sent.port.postMessage({
    channel: "moss.module.v1",
    id: sent.message.id,
    ok: true,
    result: [{ title: "Own entry" }]
  });
  assert.deepEqual(await result, [{ title: "Own entry" }]);
  sent.port.close();
  const pending = client.theme();
  const rejected = assert.rejects(pending, /Module closed/);
  client.dispose();
  await rejected;
  sent.port.close();
  await assert.rejects(client.theme(), /Module closed or busy/);
});
test("guest times out a parent which never replies", async () => {
  let port;
  const client = moduleClient({
    guestWindow: {
      parent: {
        postMessage(_, __, ports) {
          port = ports[0];
        }
      }
    },
    timeoutMs: 5
  });
  await assert.rejects(client.theme(), /Moss did not reply/);
  client.dispose();
  port.close();
});
