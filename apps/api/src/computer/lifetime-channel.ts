import type { Socket } from "node:net";
import { lifetimeError, lifetimeNow } from "./lifetime-protocol.js";

/** Dedicated bounded framing; never handed to the RFB or ordinary gateway parsers. */
export class LifetimeChannel {
  #partial = Buffer.alloc(0);
  #partialAt = 0;
  #partialTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(
    readonly socket: Socket,
    receive: (value: unknown) => void,
    readonly lost: () => void,
    readonly now = lifetimeNow
  ) {
    socket.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      try {
        if (
          !Buffer.isBuffer(chunk) ||
          chunk.length > 4096 ||
          (this.#partial.length && now() >= this.#partialAt + 2000)
        )
          throw lifetimeError();
        let frames = 0;
        let offset = 0;
        while (offset < chunk.length) {
          const end = chunk.indexOf(10, offset);
          const length = (end < 0 ? chunk.length : end) - offset;
          if (this.#partial.length + length > 1024) throw lifetimeError();
          if (!this.#partial.length) this.#partialAt = now();
          this.#partial = Buffer.concat([this.#partial, chunk.subarray(offset, offset + length)]);
          if (end < 0) {
            this.#partialTimer ??= setTimeout(() => this.close(), 2000);
            return;
          }
          if (++frames > 4) throw lifetimeError();
          clearTimeout(this.#partialTimer);
          this.#partialTimer = undefined;
          const value: unknown = JSON.parse(this.#partial.toString("utf8"));
          this.#partial = Buffer.alloc(0);
          receive(value);
          if (this.#closed) return;
          offset = end + 1;
        }
      } catch {
        this.close();
      }
    });
    socket.on("error", () => this.close());
    socket.on("end", () => this.close());
    socket.on("close", () => this.close());
  }
  send(value: unknown, flushed?: () => void) {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (
      this.#closed ||
      !this.socket.writable ||
      bytes.length > 1024 ||
      bytes.length + this.socket.writableLength > 4096
    )
      throw lifetimeError();
    this.socket.write(bytes, (error) => {
      if (error) this.close();
      else if (!this.#closed) flushed?.();
    });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#partialTimer);
    this.socket.destroy();
    this.lost();
  }
}
