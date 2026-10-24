import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPUTER_WS_MESSAGE_LIMIT,
  connectComputerGuestWebSocket
} from "../../apps/api/src/computer/guest-websocket.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "moss-ws-"));
  const server = createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  const peers = new Set<WebSocket>();
  wss.on("connection", (peer) => {
    peers.add(peer);
    peer.on("error", () => {});
  });
  const path = join(root, "guest.sock");
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const connected = once(wss, "connection");
  const stream = await connectComputerGuestWebSocket(path);
  const [peer] = (await connected) as [WebSocket];
  cleanups.push(async () => {
    stream.destroy();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { stream, peer };
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("bounded guest Unix WebSocket before RFB decoder", () => {
  it("uses actual binary framing on one fixed Unix socket and bounded manual heartbeat replies", async () => {
    const { stream, peer } = await fixture();
    const incoming = once(stream, "data");
    peer.send(Buffer.from([1, 2, 3]));
    expect([...(await incoming)[0]]).toEqual([1, 2, 3]);
    const outgoing = once(peer, "message");
    stream.write(Buffer.from([4, 5]));
    expect([...(await outgoing)[0]]).toEqual([4, 5]);
    const pong = once(peer, "pong");
    peer.ping(Buffer.from([7]));
    expect([...(await pong)[0]]).toEqual([7]);
  });

  it("rejects payload length before delivering an oversized message to the Duplex", async () => {
    const { stream, peer } = await fixture();
    let delivered = 0;
    stream.on("data", (data: Buffer) => {
      delivered += data.length;
    });
    peer.send(Buffer.alloc(COMPUTER_WS_MESSAGE_LIMIT + 1));
    await wait(150);
    expect(stream.destroyed).toBe(true);
    expect(delivered).toBe(0);
  });

  it("rejects more than 1024 fragments before delivering a complete message", async () => {
    const { stream, peer } = await fixture();
    let delivered = 0;
    stream.on("data", () => {
      delivered++;
    });
    for (let n = 0; n < 1025; n++) peer.send(Buffer.from([n % 256]), { binary: true, fin: false });
    await wait(150);
    expect(stream.destroyed).toBe(true);
    expect(delivered).toBe(0);
  });

  it("rejects text frames instead of feeding them to the RFB envelope", async () => {
    const { stream, peer } = await fixture();
    peer.send("RFB 003.008\n");
    await wait(30);
    expect(stream.destroyed).toBe(true);
  });

  it("trickled fragments after a complete message and pings cannot extend the binary deadline", async () => {
    const { stream, peer } = await fixture();
    stream.resume();
    peer.send(Buffer.from([1]));
    await wait(30);
    peer.send(Buffer.from([2]), { fin: false });
    const trickle = setInterval(() => {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(Buffer.from([3]), { fin: false });
        peer.ping();
      }
    }, 80);
    try {
      await wait(2150);
      expect(stream.destroyed).toBe(true);
    } finally {
      clearInterval(trickle);
    }
  });

  it("closes empty idle even when heartbeat pings continue", async () => {
    const { stream, peer } = await fixture();
    const ping = setInterval(() => {
      if (peer.readyState === WebSocket.OPEN) peer.ping();
    }, 80);
    try {
      await wait(2150);
      expect(stream.destroyed).toBe(true);
    } finally {
      clearInterval(ping);
    }
  });

  it("preflights all public writes before Node can enqueue a stalled adapter backlog", async () => {
    const { stream } = await fixture();
    stream.cork();
    for (let n = 0; n < 100 && !stream.destroyed; n++) stream.write(Buffer.alloc(1024));
    expect(stream.destroyed).toBe(true);
    expect(stream.writableLength).toBeLessThanOrEqual(65_536);
  });
});
