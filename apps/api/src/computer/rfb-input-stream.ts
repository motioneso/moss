import { Duplex } from "node:stream";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

/** Reject over-budget chunks before the library's asynchronous reader can retain them. */
export function boundedRfbInputStream(stream: Duplex): Duplex {
  let received = 0;
  const bounded = new Duplex({
    read() {
      stream.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (stream.destroyed || !stream.writable || stream.writableLength > 64 * 1024) {
        callback(new ComputerRfbUnavailable());
        return;
      }
      stream.write(chunk, callback);
    },
    destroy(error, callback) {
      stream.off("data", receive);
      stream.off("end", end);
      stream.off("close", close);
      stream.destroy();
      callback(error);
    }
  });
  const receive = (chunk: Buffer) => {
    received += chunk.length;
    if (received > 64 * 1024) {
      bounded.destroy(new ComputerRfbUnavailable());
      return;
    }
    if (!bounded.push(chunk)) stream.pause();
  };
  const end = () => bounded.push(null);
  const close = () => bounded.destroy();
  stream.on("data", receive);
  stream.on("end", end);
  stream.on("close", close);
  stream.on("error", close);
  return bounded;
}
