import { Duplex, duplexPair } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedComputerGuest,
  COMPUTER_PIXEL_BYTES
} from "../../apps/api/src/computer/guest-envelope.js";
import { handshake, initPacket, rawPacket, tick } from "./computer-gateway-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
function fixture() {
  const [source, writer] = duplexPair();
  const bounded = boundedComputerGuest(source);
  const records: Buffer[] = [];
  bounded.on("error", () => {});
  bounded.on("data", (record: Buffer) => records.push(record));
  cleanups.push(() => {
    bounded.destroy();
    writer.destroy();
  });
  return { bounded, writer, records, source };
}

describe("Computer guest predecoder envelope", () => {
  it("forwards fragmented valid handshake and Raw records byte exactly", async () => {
    const f = fixture();
    const wire = Buffer.concat([handshake(), rawPacket(), Buffer.from([2])]);
    for (const byte of wire) f.writer.write(Buffer.from([byte]));
    await vi.waitFor(() => expect(Buffer.concat(f.records)).toEqual(wire));
    expect(f.bounded.destroyed).toBe(false);
  });

  it.each([
    [-223, "resize"],
    [6, "compressed"],
    [7, "tight"]
  ])("rejects unrequested encoding %s before decoder delivery (%s)", async (encoding) => {
    const f = fixture();
    f.writer.write(handshake());
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    f.writer.write(rawPacket(1, 1, Number(encoding)));
    await vi.waitFor(() => expect(f.bounded.destroyed).toBe(true));
    expect(Buffer.concat(f.records)).toEqual(handshake());
  });

  it("rejects out-of-frame geometry before forwarding the allocation header", async () => {
    const f = fixture();
    f.writer.write(handshake());
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    f.writer.write(rawPacket(9, 4));
    await vi.waitFor(() => expect(f.bounded.destroyed).toBe(true));
    expect(f.records).toHaveLength(4);
  });

  it("caps aggregate pixels even for individually valid overlapping rectangles", async () => {
    const f = fixture();
    const init = Buffer.concat([handshake().subarray(0, 18), initPacket(1280, 800)]);
    f.writer.write(init);
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    const first = rawPacket(1280, 800);
    first.writeUInt16BE(2, 2);
    f.writer.write(first);
    await tick();
    f.writer.write(rawPacket(1, 1).subarray(4));
    await vi.waitFor(() => expect(f.bounded.destroyed).toBe(true));
    expect(f.records).toHaveLength(4);
  });

  it("rejects oversized name, dimensions, record count and chunks", async () => {
    for (const mutation of ["name", "dimensions", "count", "chunk"]) {
      const f = fixture();
      if (mutation === "name" || mutation === "dimensions") {
        const wire = handshake();
        if (mutation === "name") wire.writeUInt32BE(4097, wire.length - 4);
        else wire.writeUInt16BE(1281, 18);
        f.writer.write(wire);
      } else {
        f.writer.write(handshake());
        await vi.waitFor(() => expect(f.records).toHaveLength(4));
        f.writer.write(
          mutation === "chunk"
            ? Buffer.alloc(COMPUTER_PIXEL_BYTES + 4097)
            : Buffer.from([0, 0, 1, 1])
        );
      }
      await vi.waitFor(() => expect(f.bounded.destroyed).toBe(true));
    }
  });

  it("expires a trickled partial record while keeping empty idle alive", async () => {
    const f = fixture();
    f.writer.write(handshake());
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.bounded.destroyed).toBe(false);
    f.writer.write(Buffer.from([0]));
    await tick();
    await vi.advanceTimersByTimeAsync(1500);
    f.writer.write(Buffer.from([0]));
    await tick();
    await vi.advanceTimersByTimeAsync(501);
    expect(f.bounded.destroyed).toBe(true);
  });

  it("rejects clipboard/unknown messages and oversized Fence payload", async () => {
    for (const bad of [
      Buffer.from([3]),
      Buffer.from([255]),
      Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 65])
    ]) {
      const f = fixture();
      f.writer.write(handshake());
      await vi.waitFor(() => expect(f.records).toHaveLength(4));
      f.writer.write(bad);
      await vi.waitFor(() => expect(f.bounded.destroyed).toBe(true));
    }
  });

  it("caps raw plus wrapper queues before a stalled write can enqueue another reply", async () => {
    const source = new Duplex({ read() {}, write() {} });
    const bounded = boundedComputerGuest(source);
    bounded.on("error", () => {});
    cleanups.push(() => bounded.destroy());
    for (let index = 0; index < 1200 && !bounded.destroyed; index++) {
      bounded.write(Buffer.alloc(73));
      expect(source.writableLength + bounded.writableLength).toBeLessThanOrEqual(65_536);
    }
    expect(bounded.destroyed).toBe(true);
  });

  it("reserves raw duplication when a larger queued write starts after a smaller one", async () => {
    const callbacks: (() => void)[] = [];
    const source = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callbacks.push(callback);
      }
    });
    const bounded = boundedComputerGuest(source);
    bounded.on("error", () => {});
    cleanups.push(() => bounded.destroy());
    bounded.write(Buffer.alloc(9));
    bounded.write(Buffer.alloc(73));
    for (let index = 0; index < 7270 && !bounded.destroyed; index++) bounded.write(Buffer.alloc(9));
    if (!bounded.destroyed) callbacks[0]!();
    await tick();
    expect(source.writableLength + bounded.writableLength).toBeLessThanOrEqual(65_536);
    // Any further queued writes must reserve their future raw copies as well.
    for (let index = 0; index < 1000 && !bounded.destroyed; index++)
      bounded.write(Buffer.alloc(73));
    expect(bounded.destroyed).toBe(true);
    expect(source.writableLength + bounded.writableLength).toBeLessThanOrEqual(65_536);
  });
});
