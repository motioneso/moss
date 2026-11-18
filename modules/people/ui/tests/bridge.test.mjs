import { test } from "node:test";
import assert from "node:assert/strict";
import { connectModuleFrame } from "../../../../rust-spike/module-ui/web/host-bridge.mjs";
import { moduleClient } from "../../../../rust-spike/module-ui/web/guest-bridge.mjs";
import { peopleBridge } from "../web/bridge.mjs";

test("People receives the body from the shared frame and rejects failed requests", async () => {
  let connect;
  const source = {};
  const frame = Object.assign(new EventTarget(), { contentWindow: source, style: {} });
  const calls = [];
  const dispose = connectModuleFrame(frame, "people", {
    hostWindow: {
      addEventListener: (_, listener) => {
        connect = listener;
      },
      removeEventListener() {}
    },
    request(method, path, body) {
      calls.push([method, path, body]);
      if (method === "PUT") throw new Error("Private backend diagnostic");
      return { folder: "People" };
    },
    theme: () => ({}),
    navigate: () => null,
    chat: () => null
  });
  const { client, api } = peopleBridge(
    moduleClient({
      timeoutMs: 1000,
      guestWindow: {
        parent: {
          postMessage(data, _, ports) {
            connect({ data, ports, source, origin: "null" });
          }
        }
      }
    })
  );
  try {
    frame.dispatchEvent(new Event("load"));
    assert.deepEqual(JSON.parse(await api.request("GET", "/people/notes-settings", "null")), {
      folder: "People"
    });
    assert.deepEqual(calls[0], ["GET", "/api/m/people/people/notes-settings", null]);
    await assert.rejects(
      api.request("PUT", "/people/notes-settings", '{"folder":null}'),
      /Moss could not finish this request/
    );
  } finally {
    client.dispose();
    dispose();
  }
});
