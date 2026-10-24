import { Duplex, type DuplexOptions } from "node:stream";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

export const COMPUTER_PIXEL_BYTES = 1280 * 800 * 4;
const RECORD_BYTES = COMPUTER_PIXEL_BYTES + 4096;
const DEADLINE_MS = 2000;

/** Guard every write before Node can enqueue it, including vendor-generated Fence replies. */
class GuestDuplex extends Duplex {
  constructor(
    private readonly source: Duplex,
    options: DuplexOptions
  ) {
    super(options);
  }

  override write(
    chunk: Uint8Array | string,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    const done = typeof encoding === "function" ? encoding : callback;
    // Reserve raw duplication for every queued adapter chunk, including the next _write.
    if (
      !Buffer.isBuffer(chunk) ||
      this.destroyed ||
      this.source.destroyed ||
      2 * (this.writableLength + chunk.length) + this.source.writableLength > 65_536
    ) {
      const error = new ComputerRfbUnavailable();
      this.destroy(error);
      if (done) queueMicrotask(() => done(error));
      return false;
    }
    return typeof encoding === "string"
      ? super.write(chunk, encoding, callback)
      : super.write(chunk, done);
  }
}

/** Rejecting RFB envelope only. The vendor still owns decoding and protocol responses. */
class GuestRecords {
  #phase = 0;
  #width = 0;
  #height = 0;

  get initialized() {
    return this.#phase === 4;
  }

  next(data: Buffer): number | undefined {
    if (!data.length) return;
    let length: number;
    switch (this.#phase) {
      case 0:
        length = 12;
        if (data.length < length) return;
        if (data.toString("ascii", 0, length) !== "RFB 003.008\n") this.#deny();
        break;
      case 1:
        length = 1 + data[0]!;
        if (length < 2 || length > 17) this.#deny();
        if (data.length < length) return;
        if (!data.subarray(1, length).includes(1)) this.#deny();
        break;
      case 2:
        length = 4;
        if (data.length < length) return;
        if (data.readUInt32BE(0) !== 0) this.#deny();
        break;
      case 3: {
        if (data.length < 24) return;
        this.#width = data.readUInt16BE(0);
        this.#height = data.readUInt16BE(2);
        const name = data.readUInt32BE(20);
        if (
          this.#width < 1 ||
          this.#width > 1280 ||
          this.#height < 1 ||
          this.#height > 800 ||
          name > 4096 ||
          data[4] !== 32 ||
          data[5] !== 24 ||
          data[6] !== 0 ||
          data[7] !== 1 ||
          data.readUInt16BE(8) !== 255 ||
          data.readUInt16BE(10) !== 255 ||
          data.readUInt16BE(12) !== 255 ||
          data[15] !== 8 ||
          !((data[14] === 16 && data[16] === 0) || (data[14] === 0 && data[16] === 16))
        )
          this.#deny();
        length = 24 + name;
        if (data.length < length) return;
        break;
      }
      default:
        return this.#message(data);
    }
    this.#phase++;
    return length;
  }

  #message(data: Buffer): number | undefined {
    if (data[0] === 2) return 1; // Bell has no body.
    if (data[0] === 248) {
      if (data.length < 9) return;
      const length = data[8]!;
      if (length > 64) this.#deny();
      return data.length >= 9 + length ? 9 + length : undefined;
    }
    if (data[0] !== 0) this.#deny();
    if (data.length < 4) return;
    const count = data.readUInt16BE(2);
    if (count > 256) this.#deny();
    let offset = 4;
    let pixels = 0;
    for (let index = 0; index < count; index++) {
      if (data.length < offset + 12) return;
      const x = data.readUInt16BE(offset);
      const y = data.readUInt16BE(offset + 2);
      const width = data.readUInt16BE(offset + 4);
      const height = data.readUInt16BE(offset + 6);
      // Reject unrequested encodings BEFORE the vendor sees an allocation-driving header.
      if (data.readInt32BE(offset + 8) !== 0) this.#deny();
      const bytes = width * height * 4;
      pixels += bytes;
      if (
        !width ||
        !height ||
        x + width > this.#width ||
        y + height > this.#height ||
        pixels > COMPUTER_PIXEL_BYTES
      )
        this.#deny();
      offset += 12 + bytes;
      if (data.length < offset) return;
    }
    return offset;
  }

  #deny(): never {
    throw new ComputerRfbUnavailable();
  }
}

/** One validated record per event-loop turn prevents the vendor ByteReader accumulating updates. */
export function boundedComputerGuest(stream: Duplex): Duplex {
  const records = new GuestRecords();
  const storage = Buffer.allocUnsafe(RECORD_BYTES);
  let used = 0;
  let readable = true;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let partial: ReturnType<typeof setTimeout> | undefined;
  const handshake = setTimeout(() => fail(), DEADLINE_MS);
  const bounded = new GuestDuplex(stream, {
    read() {
      readable = true;
      schedule();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (stream.destroyed || !stream.writable || stream.writableLength + chunk.length > 65_536) {
        callback(new ComputerRfbUnavailable());
        return;
      }
      stream.write(chunk, callback);
    },
    destroy(error, callback) {
      clearTimeout(handshake);
      clearTimeout(partial);
      clearImmediate(scheduled);
      stream.off("data", receive);
      stream.destroy();
      used = 0;
      callback(error);
    }
  });
  const fail = () => bounded.destroy(new ComputerRfbUnavailable());
  function schedule() {
    if (scheduled || bounded.destroyed || !readable) return;
    scheduled = setImmediate(pump);
  }
  function pump() {
    scheduled = undefined;
    if (bounded.destroyed) return;
    try {
      const length = records.next(storage.subarray(0, used));
      if (length === undefined) {
        stream.resume();
        return;
      }
      const record = Buffer.from(storage.subarray(0, length));
      storage.copy(storage, 0, length, used);
      used -= length;
      clearTimeout(partial);
      partial = used ? setTimeout(fail, DEADLINE_MS) : undefined;
      if (records.initialized) clearTimeout(handshake);
      readable = bounded.push(record);
      schedule();
    } catch {
      fail();
    }
  }
  function receive(chunk: Buffer) {
    stream.pause();
    if (
      !Buffer.isBuffer(chunk) ||
      chunk.length > RECORD_BYTES ||
      used + chunk.length > RECORD_BYTES
    ) {
      fail();
      return;
    }
    if (!used && chunk.length) partial = setTimeout(fail, DEADLINE_MS);
    chunk.copy(storage, used);
    used += chunk.length;
    schedule();
  }
  stream.pause();
  stream.on("data", receive);
  stream.on("error", fail);
  stream.on("end", fail);
  stream.on("close", fail);
  // The source is exclusively owned; no other data consumer may bypass this envelope.
  return bounded;
}
