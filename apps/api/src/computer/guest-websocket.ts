import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { isAbsolute } from "node:path";
import WebSocket from "ws";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

export const COMPUTER_WS_MESSAGE_LIMIT = 1280 * 800 * 4 + 4096;
const WRITE_LIMIT = 65_536;

/** Separate gateway only. Public ws decoder limits are installed before any handshake bytes. */
export function connectComputerGuestWebSocket(socketPath: string): Promise<Duplex> {
  if (!isAbsolute(socketPath)) return Promise.reject(new ComputerRfbUnavailable());
  return new Promise((resolve, reject) => {
    const options: WebSocket.ClientOptions & { maxFragments: number; maxBufferedChunks: number } = {
      createConnection: () => createConnection({ path: socketPath }),
      followRedirects: false,
      perMessageDeflate: false,
      autoPong: false,
      handshakeTimeout: 2000,
      maxPayload: COMPUTER_WS_MESSAGE_LIMIT,
      maxFragments: 1024,
      maxBufferedChunks: 1024,
      allowSynchronousEvents: false
    };
    const ws = new WebSocket("ws://localhost/", "binary", options);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stream = new (class extends Duplex {
      override _read() {
        ws.resume();
      }
      override write(
        chunk: Uint8Array | string,
        encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void
      ): boolean {
        const size =
          typeof chunk === "string"
            ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined)
            : chunk.byteLength;
        const cb = typeof encoding === "function" ? encoding : callback;
        // Reserve all queued adapter copies and their maximum WS header/masking overhead.
        if (
          ws.readyState !== WebSocket.OPEN ||
          2 * this.writableLength + ws.bufferedAmount + 2 * size + 28 > WRITE_LIMIT
        ) {
          this.destroy();
          cb?.(new ComputerRfbUnavailable());
          return false;
        }
        return typeof encoding === "string"
          ? super.write(chunk, encoding, callback)
          : super.write(chunk, cb);
      }
      override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void
      ) {
        if (
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount + chunk.length + 14 > WRITE_LIMIT
        ) {
          callback(new ComputerRfbUnavailable());
          return;
        }
        ws.send(chunk, { binary: true, compress: false }, callback);
        if (ws.bufferedAmount > WRITE_LIMIT) this.destroy();
      }
      override _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
        clearTimeout(deadline);
        ws.terminate();
        callback();
      }
    })();
    stream.on("error", () => {});
    const fail = () => {
      stream.destroy();
      reject(new ComputerRfbUnavailable());
    };
    const refreshDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(fail, 2000);
    };
    ws.on("error", fail);
    ws.on("close", fail);
    ws.on("open", () => {
      if (ws.protocol !== "binary" || ws.extensions || stream.destroyed) {
        fail();
        return;
      }
      refreshDeadline();
      resolve(stream);
    });
    ws.on("message", (data, binary) => {
      if (
        !binary ||
        !Buffer.isBuffer(data) ||
        stream.readableLength + data.length > 2 * COMPUTER_WS_MESSAGE_LIMIT
      ) {
        fail();
        return;
      }
      // Fragments and ping/pong never extend the always-armed complete-message deadline.
      refreshDeadline();
      if (!stream.push(data)) ws.pause();
    });
    ws.on("ping", (data: Buffer) => {
      if (
        stream.destroyed ||
        ws.readyState !== WebSocket.OPEN ||
        2 * stream.writableLength + ws.bufferedAmount + data.length + 14 > WRITE_LIMIT
      ) {
        fail();
        return;
      }
      ws.pong(data, true, (error) => {
        if (error) fail();
      });
      if (ws.bufferedAmount > WRITE_LIMIT) fail();
    });
  });
}
