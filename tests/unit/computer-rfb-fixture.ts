import { once } from "node:events";
import { Duplex, duplexPair } from "node:stream";
import { fenceFlags, RfbClient, RfbServerConnection } from "rfb2";
import { vi } from "vitest";
import { ComputerRfbInput } from "../../apps/api/src/computer/rfb-input.js";
import type { BrowserSessionBinding } from "@moss/auth";

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const binding = (sessionId = "session", actorUserId = "owner"): BrowserSessionBinding => ({
  sessionId,
  actorUserId,
  requestId: "test",
  expiresAt: new Date("2030-01-01T00:00:00Z")
});

export function fencePacket(flags: number, payload: Buffer): Buffer {
  const packet = Buffer.alloc(9 + payload.length);
  packet[0] = 248;
  packet.writeUInt32BE(flags >>> 0, 4);
  packet[8] = payload.length;
  payload.copy(packet, 9);
  return packet;
}

/** In-memory guest stand-in. rfb2's server lacks Fence, so only that extension is supplied here. */
export async function rfbFixture(timeoutMs = 2000) {
  const [transport, guestStream] = duplexPair();
  const events: unknown[][] = [];
  const fences: Buffer[] = [];
  let automaticFences = true;
  let stalled = false;
  const proxy = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (stalled) return;
      if (chunk[0] === 248) {
        if ((chunk.readUInt32BE(4) & fenceFlags.request) !== 0) {
          const payload = Buffer.from(chunk.subarray(9));
          fences.push(payload);
          if (automaticFences) acknowledge(payload);
        }
        callback();
      } else transport.write(chunk, callback);
    },
    destroy(error, callback) {
      transport.destroy();
      callback(error);
    }
  });
  transport.on("data", (chunk: Buffer) => proxy.push(chunk));
  transport.on("end", () => proxy.push(null));
  transport.on("error", () => proxy.destroy());
  const guest = new RfbServerConnection(guestStream, { width: 1280, height: 800 });
  guest.on("error", () => undefined);
  guest.on("key", (e) => events.push(["key", e.keysym, e.down]));
  guest.on("pointer", (e) => events.push(["pointer", e.x, e.y, e.buttons]));
  guest.once("ready", () => guest.write(fencePacket(0, Buffer.alloc(0))));
  const upstream = new RfbClient({ stream: proxy, initialUpdate: false });
  upstream.on("error", () => undefined);
  const announced = once(upstream, "fence");
  await once(upstream, "connect");
  await announced;
  function acknowledge(payload: Buffer, flags: number = fenceFlags.blockBefore) {
    setImmediate(() => {
      events.push(["fence", payload.toString("hex")]);
      guest.write(fencePacket(flags, payload));
    });
  }
  const assertLive = vi.fn<() => Promise<void>>(async () => undefined);
  const receiver = new ComputerRfbInput({
    ownerUserId: "owner",
    sessions: { assertLive },
    now: () => new Date("2026-10-23T00:00:00Z"),
    upstream,
    timeoutMs
  });
  const clients: RfbClient[] = [];
  return {
    receiver,
    upstream,
    guest,
    proxy,
    events,
    fences,
    assertLive,
    acknowledge,
    holdFences() {
      automaticFences = false;
    },
    stall() {
      stalled = true;
    },
    async attach(viewer: Awaited<ReturnType<typeof receiver.connect>>, controlling = false) {
      const [clientStream, serverStream] = duplexPair();
      // duplexPair has independent destruction; model the peer loss a socket would report.
      clientStream.once("close", () => serverStream.destroy());
      serverStream.once("close", () => clientStream.destroy());
      if (controlling) await receiver.attachController(viewer, serverStream);
      else receiver.attachWatcher(viewer, serverStream);
      const client = new RfbClient({ stream: clientStream, initialUpdate: false });
      clients.push(client);
      client.on("error", () => undefined);
      await once(client, "connect");
      return client;
    },
    async dispose() {
      for (const client of clients) client.destroy();
      await receiver.close().catch(() => undefined);
      upstream.destroy();
      guest.destroy();
      guestStream.destroy();
      proxy.destroy();
    }
  };
}
