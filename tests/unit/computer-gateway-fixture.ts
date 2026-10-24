import { once } from "node:events";
import { Duplex, duplexPair } from "node:stream";
import { RfbClient, RfbServerConnection, type PixelFormatName } from "rfb2";
import { connectComputerReceivingGateway } from "../../apps/api/src/computer/receiving-gateway.js";
import type { ComputerViewer } from "../../apps/api/src/computer/input-control.js";
import { authFixture, binding, OWNER } from "./computer-auth-fixture.js";
import { fencePacket } from "./computer-rfb-fixture.js";

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export const WIDTH = 8;
export const HEIGHT = 4;
export const pixels = Buffer.from(
  Array.from({ length: WIDTH * HEIGHT }, () => [17, 34, 204, 0]).flat()
);

/** Library guest + Fence extension stand-in, never a live TigerVNC/resource qualification. */
export async function gatewayFixture(options: { partialFirstFrame?: boolean } = {}) {
  const auth = await authFixture();
  const [transport, guestStream] = duplexPair();
  const events: unknown[][] = [];
  let reply = true;
  let holdFence = false;
  let heldFenceStart = 0;
  let stalledOutput = false;
  const fences: Buffer[] = [];
  const upstream = new Duplex({
    read() {
      transport.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (stalledOutput) return;
      if (chunk[0] === 248) {
        const payload = Buffer.from(chunk.subarray(9));
        fences.push(payload);
        if (!holdFence) setImmediate(() => guest.write(fencePacket(1, payload)));
        callback();
      } else transport.write(chunk, callback);
    },
    destroy(error, callback) {
      transport.destroy();
      callback(error);
    }
  });
  transport.on("data", (chunk: Buffer) => {
    if (!upstream.push(chunk)) transport.pause();
  });
  transport.on("error", () => upstream.destroy());
  transport.on("close", () => upstream.destroy());
  const guest = new RfbServerConnection(guestStream, { width: WIDTH, height: HEIGHT });
  guest.on("error", () => {});
  guest.on("key", (event) => events.push(["key", event.keysym, event.down]));
  guest.on("pointer", (event) => events.push(["pointer", event.x, event.y, event.buttons]));
  guest.once("ready", () => guest.write(fencePacket(0, Buffer.alloc(0))));
  let firstFrame = true;
  const sendFrame = () => {
    const width = firstFrame && options.partialFirstFrame ? WIDTH - 1 : WIDTH;
    firstFrame = false;
    guest.sendUpdate([
      {
        type: "pixels",
        x: 0,
        y: 0,
        width,
        height: HEIGHT,
        data: pixels.subarray(0, width * HEIGHT * 4)
      }
    ]);
  };
  guest.on("updateRequest", () => {
    if (reply) sendFrame();
  });
  const gateway = await connectComputerReceivingGateway({
    ownerUserId: OWNER,
    authSocketPath: auth.socketPath,
    upstream
  });
  const clients: RfbClient[] = [];
  const outputs = new Map<RfbClient, { blocked: boolean }>();
  return {
    auth,
    gateway,
    guest,
    guestStream,
    upstream,
    events,
    fences,
    sendFrame,
    noFrames() {
      reply = false;
    },
    holdFences() {
      holdFence = true;
      heldFenceStart = fences.length;
    },
    releaseFences() {
      holdFence = false;
      for (const payload of fences.slice(heldFenceStart)) guest.write(fencePacket(1, payload));
    },
    stallUpstreamOutput() {
      stalledOutput = true;
    },
    stallOutput(client: RfbClient) {
      outputs.get(client)!.blocked = true;
    },
    async open(session = binding()) {
      return gateway.openViewer(auth.server.issue(session));
    },
    async attach(
      viewer: ComputerViewer,
      controlling = false,
      pixelFormat: PixelFormatName = "bgrx"
    ) {
      const [clientStream, downstream] = duplexPair();
      const output = { blocked: false };
      const serverStream = new Duplex({
        read() {
          downstream.resume();
        },
        write(chunk: Buffer, _encoding, callback) {
          if (!output.blocked) downstream.write(chunk, callback);
          // A blocked raw write deliberately never completes until stream destruction.
        },
        destroy(error, callback) {
          downstream.destroy();
          callback(error);
        }
      });
      downstream.on("data", (chunk: Buffer) => {
        if (!serverStream.push(chunk)) downstream.pause();
      });
      downstream.on("error", () => serverStream.destroy());
      downstream.on("close", () => serverStream.destroy());
      clientStream.once("close", () => serverStream.destroy());
      serverStream.once("close", () => clientStream.destroy());
      if (controlling) await gateway.attachController(viewer, serverStream);
      else gateway.attachWatcher(viewer, serverStream);
      const client = new RfbClient({ stream: clientStream, pixelFormat, initialUpdate: false });
      clients.push(client);
      outputs.set(client, output);
      client.on("error", () => {});
      await once(client, "connect");
      return client;
    },
    async frame(client: RfbClient) {
      const frame = once(client, "update");
      client.requestUpdate(false);
      return (await frame)[0];
    },
    async close() {
      for (const client of clients) client.destroy();
      await gateway.close();
      guest.destroy();
      guestStream.destroy();
      await auth.close();
    }
  };
}

export function initPacket(width = WIDTH, height = HEIGHT): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
  return init;
}
export function handshake() {
  return Buffer.concat([
    Buffer.from("RFB 003.008\n"),
    Buffer.from([1, 1]),
    Buffer.alloc(4),
    initPacket()
  ]);
}
export function rawPacket(width = WIDTH, height = HEIGHT, encoding = 0): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  header.writeInt32BE(encoding, 12);
  return Buffer.concat([header, Buffer.alloc(width * height * 4)]);
}
