import { Framebuffer, pixelFormats, type PixelFormat, type Update } from "rfb2";
import type { ComputerRfbConnection } from "./rfb-input.js";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

function supportedFormat(format: PixelFormat): boolean {
  return [pixelFormats.bgrx, pixelFormats.rgbx].some((allowed) =>
    (Object.keys(allowed) as (keyof PixelFormat)[]).every((key) => format[key] === allowed[key])
  );
}

/** One fixed-size framebuffer and one coalesced request bit per receiving parser. */
export class ComputerReceivingFrames {
  readonly #frame: Framebuffer;
  readonly #connections = new Map<ComputerRfbConnection, { pending: boolean }>();
  #ready = false;

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.#frame = new Framebuffer(width, height, pixelFormats.bgrx);
  }

  get ready() {
    return this.#ready;
  }

  apply(update: Update): void {
    if (!this.#ready) {
      const first = update.rects[0];
      if (
        update.rects.length !== 1 ||
        !first ||
        first.type !== "pixels" ||
        first.x !== 0 ||
        first.y !== 0 ||
        first.width !== this.width ||
        first.height !== this.height
      )
        throw new ComputerRfbUnavailable();
    }
    for (const rect of update.rects) {
      if (rect.type !== "pixels") throw new ComputerRfbUnavailable();
      this.#frame.put(rect.x, rect.y, rect.width, rect.height, rect.data);
    }
    this.#ready = true;
  }

  attach(input: ComputerRfbConnection): void {
    const state = { pending: false };
    this.#connections.set(input, state);
    input.connection.on("updateRequest", () => {
      state.pending = true;
    });
    input.connection.on("setPixelFormat", (format) => {
      if (!supportedFormat(format)) input.connection.destroy();
    });
    input.connection.once("close", () => this.#connections.delete(input));
  }

  render(): void {
    if (!this.#ready) return;
    for (const [input, state] of this.#connections) {
      if (!state.pending) continue;
      state.pending = false;
      const { transport, parserStream, connection } = input;
      const packetBytes = this.#frame.data.length + 16;
      if (
        transport.destroyed ||
        parserStream.destroyed ||
        !transport.writable ||
        !supportedFormat(connection.clientPixelFormat) ||
        transport.writableLength + parserStream.writableLength + packetBytes > 2 * packetBytes
      ) {
        connection.destroy();
        continue;
      }
      try {
        connection.sendUpdate([
          {
            type: "pixels",
            x: 0,
            y: 0,
            width: this.width,
            height: this.height,
            data: this.#frame.data
          }
        ]);
      } catch {
        connection.destroy();
      }
    }
  }

  close(): void {
    for (const input of this.#connections.keys()) input.connection.destroy();
    this.#connections.clear();
    this.#ready = false;
  }
}
