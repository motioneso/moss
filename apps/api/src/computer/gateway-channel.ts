import { createConnection, type Socket } from "node:net";
import { isRecord } from "./host-contract.js";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

export const GATEWAY_LINE_LIMIT = 1024;
export const GATEWAY_OPERATION_MS = 5000;
export type GatewayOperation = "takeOver" | "returnToMoss" | "closeViewer" | "snapshot";
export const gatewayOperations: readonly string[] = [
  "takeOver",
  "returnToMoss",
  "closeViewer",
  "snapshot"
];
export function gatewayFields(value: unknown, keys: string): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === keys;
}

/** One bounded JSON command at a time. Raw RFB handoff removes this parser permanently. */
export class GatewayChannel {
  #partial = Buffer.alloc(0);
  #tail: Buffer = Buffer.alloc(0);
  #partialTimer?: ReturnType<typeof setTimeout>;
  #ended = false;
  constructor(
    readonly socket: Socket,
    receive: (value: unknown) => void,
    readonly lost: () => void,
    allowHandoffTail = false
  ) {
    this.#receive = (chunk: Buffer) => {
      if (this.#ended) return;
      try {
        const newline = chunk.indexOf(10);
        const length = newline < 0 ? chunk.length : newline;
        if (this.#partial.length + length > GATEWAY_LINE_LIMIT) throw new ComputerRfbUnavailable();
        this.#partial = Buffer.concat([this.#partial, chunk.subarray(0, length)]);
        if (newline < 0) {
          this.#partialTimer ??= setTimeout(() => this.close(), 2000);
          return;
        }
        this.#tail = chunk.subarray(newline + 1);
        if (this.#tail.length && !allowHandoffTail) throw new ComputerRfbUnavailable();
        clearTimeout(this.#partialTimer);
        this.#partialTimer = undefined;
        const value: unknown = JSON.parse(this.#partial.toString("utf8"));
        this.#partial = Buffer.alloc(0);
        receive(value);
        if (!this.#ended && this.#tail.length) throw new ComputerRfbUnavailable();
        this.#tail = Buffer.alloc(0);
      } catch {
        this.close();
      }
    };
    socket.on("data", this.#receive);
    socket.on("error", this.#lost);
    socket.on("close", this.#lost);
    socket.on("end", this.#lost);
  }
  readonly #receive: (chunk: Buffer) => void;
  readonly #lost = () => this.close();
  get ended() {
    return this.#ended;
  }
  send(value: unknown) {
    const frame = Buffer.from(JSON.stringify(value) + "\n");
    if (
      this.#ended ||
      !this.socket.writable ||
      frame.length > GATEWAY_LINE_LIMIT ||
      this.socket.writableLength + frame.length > 65_536
    )
      throw new ComputerRfbUnavailable();
    this.socket.write(frame);
  }
  takeStream(): Socket {
    if (this.#ended) throw new ComputerRfbUnavailable();
    this.#detach();
    this.socket.pause();
    if (this.#tail.length) this.socket.unshift(this.#tail);
    this.#tail = Buffer.alloc(0);
    return this.socket;
  }
  close() {
    if (this.#ended) return;
    this.#detach();
    this.socket.destroy();
    this.lost();
  }
  #detach() {
    this.#ended = true;
    clearTimeout(this.#partialTimer);
    this.socket.off("data", this.#receive);
    this.socket.off("error", this.#lost);
    this.socket.off("close", this.#lost);
    this.socket.off("end", this.#lost);
    // Socket errors after handoff/teardown remain terminal, never uncaught process errors.
    this.socket.on("error", () => {});
  }
}

export function gatewaySocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => socket.destroy(new ComputerRfbUnavailable()), 2000);
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new ComputerRfbUnavailable());
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}
