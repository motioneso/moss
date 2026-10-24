import type { Socket } from "node:net";
import {
  GatewayChannel,
  gatewayFields,
  gatewaySocket,
  GATEWAY_OPERATION_MS,
  type GatewayOperation
} from "./gateway-channel.js";
import { isUuid } from "./host-contract.js";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

export interface ComputerGatewaySnapshot {
  mode: "paused" | "owner" | "moss";
  viewerCount: number;
  receivingReady: boolean;
  closed: boolean;
  frameReady: boolean;
}
function snapshot(value: unknown): ComputerGatewaySnapshot {
  if (
    !gatewayFields(value, "closed,frameReady,mode,receivingReady,viewerCount") ||
    (value.mode !== "paused" && value.mode !== "owner" && value.mode !== "moss") ||
    typeof value.viewerCount !== "number" ||
    !Number.isInteger(value.viewerCount) ||
    value.viewerCount < 0 ||
    value.viewerCount > 4 ||
    typeof value.closed !== "boolean" ||
    typeof value.frameReady !== "boolean" ||
    typeof value.receivingReady !== "boolean"
  )
    throw new ComputerRfbUnavailable();
  return {
    mode: value.mode,
    viewerCount: value.viewerCount,
    closed: value.closed,
    frameReady: value.frameReady,
    receivingReady: value.receivingReady
  };
}

/** Trusted API IPC client, not browser auth. Core capabilities stay inside the gateway process. */
export async function connectComputerGatewayViewer(input: {
  socketPath: string;
  viewerId: string;
}) {
  if (!isUuid(input.viewerId)) throw new ComputerRfbUnavailable();
  const socket = await gatewaySocket(input.socketPath);
  const viewer = new ComputerGatewayViewer(input, socket);
  await viewer.open();
  return viewer;
}

class ComputerGatewayViewer {
  readonly #channel: GatewayChannel;
  readonly #streams = new Set<Socket>();
  #ended = false;
  #requestId = 0;
  #pending?: {
    id: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    operation: string;
  };
  constructor(
    private readonly input: { socketPath: string; viewerId: string },
    socket: Socket
  ) {
    this.#channel = new GatewayChannel(
      socket,
      (value) => {
        const pending = this.#pending;
        try {
          if (
            !pending ||
            !gatewayFields(
              value,
              pending.operation === "snapshot" ? "requestId,snapshot,type" : "requestId,type"
            ) ||
            value.type !== "ok" ||
            value.requestId !== pending.id
          )
            throw new ComputerRfbUnavailable();
          const result = pending.operation === "snapshot" ? snapshot(value.snapshot) : undefined;
          clearTimeout(pending.timer);
          this.#pending = undefined;
          pending.resolve(result);
        } catch {
          this.disconnect();
        }
      },
      () => this.disconnect()
    );
  }
  async open() {
    await this.#request("open");
  }
  async takeOver() {
    await this.#request("takeOver");
  }
  async returnToMoss() {
    await this.#request("returnToMoss");
  }
  async closeViewer() {
    await this.#request("closeViewer");
    this.disconnect();
  }
  async snapshot(): Promise<ComputerGatewaySnapshot> {
    return snapshot(await this.#request("snapshot"));
  }
  watch(): Promise<Socket> {
    return this.#stream("watch");
  }
  controller(): Promise<Socket> {
    return this.#stream("control");
  }
  disconnect() {
    if (this.#ended) return;
    this.#ended = true;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerRfbUnavailable());
    }
    this.#channel.close();
    for (const stream of this.#streams) stream.destroy();
    this.#streams.clear();
  }
  async #request(operation: GatewayOperation | "open"): Promise<unknown> {
    if (this.#ended || this.#pending || this.#requestId >= 8192)
      return Promise.reject(new ComputerRfbUnavailable());
    const result = await new Promise((resolve, reject) => {
      const id = ++this.#requestId;
      const timer = setTimeout(() => this.disconnect(), GATEWAY_OPERATION_MS);
      this.#pending = { id, resolve, reject, timer, operation };
      try {
        this.#channel.send(
          operation === "open"
            ? { type: operation, requestId: id, viewerId: this.input.viewerId }
            : { type: operation, requestId: id }
        );
      } catch {
        this.disconnect();
      }
    });
    if (this.#ended) throw new ComputerRfbUnavailable();
    return result;
  }
  async #stream(type: "watch" | "control"): Promise<Socket> {
    if (this.#ended) throw new ComputerRfbUnavailable();
    const socket = await gatewaySocket(this.input.socketPath);
    if (this.#ended) {
      socket.destroy();
      throw new ComputerRfbUnavailable();
    }
    this.#streams.add(socket);
    socket.once("close", () => this.#streams.delete(socket)); // Raw stream loss is core policy, not control loss.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => channel.close(), GATEWAY_OPERATION_MS);
      const channel = new GatewayChannel(
        socket,
        (value) => {
          if (
            this.#ended ||
            !gatewayFields(value, "requestId,type") ||
            value.type !== "ok" ||
            value.requestId !== 1
          ) {
            channel.close();
            return;
          }
          clearTimeout(timer);
          resolve(channel.takeStream());
        },
        () => {
          clearTimeout(timer);
          reject(new ComputerRfbUnavailable());
        },
        true
      );
      try {
        channel.send({ type, requestId: 1, viewerId: this.input.viewerId });
      } catch {
        channel.close();
      }
    });
  }
}
