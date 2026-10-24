import { randomBytes } from "node:crypto";
import { fenceFlags, type RfbClient } from "rfb2";

export type ComputerInputEvent =
  | { readonly type: "key"; readonly keysym: number; readonly down: boolean }
  | { readonly type: "pointer"; readonly x: number; readonly y: number; readonly buttons: number };

export class ComputerRfbUnavailable extends Error {
  constructor() {
    super("Computer receiving input is unavailable");
    this.name = "ComputerRfbUnavailable";
  }
}

const MAX_BACKLOG = 64 * 1024;
type PendingFence = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One trusted upstream writer. Fence replies are protocol acknowledgements, not live proof. */
export class ComputerRfbInputWriter {
  readonly #keys = new Set<number>();
  readonly #pending = new Map<string, PendingFence>();
  #pointer = { x: 0, y: 0, buttons: 0 };
  #closed = false;

  constructor(
    readonly client: RfbClient,
    private readonly timeoutMs: number,
    private readonly failed: () => void
  ) {
    if (
      !client.supports.fence ||
      !Number.isInteger(client.width) ||
      !Number.isInteger(client.height) ||
      client.width < 1 ||
      client.height < 1 ||
      client.width > 1280 ||
      client.height > 800 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2000
    )
      throw new ComputerRfbUnavailable();
    this.#check();
    client.on("fence", this.#fence);
    client.on("error", this.#failure);
    client.on("close", this.#failure);
  }

  send(event: ComputerInputEvent): void {
    if (event.type === "key") {
      if (
        !Number.isInteger(event.keysym) ||
        event.keysym < 1 ||
        event.keysym > 0xffffffff ||
        typeof event.down !== "boolean" ||
        (event.down && !this.#keys.has(event.keysym) && this.#keys.size >= 64)
      )
        throw new ComputerRfbUnavailable();
      this.#write(() => this.client.keyEvent(event.keysym, event.down));
      if (event.down) this.#keys.add(event.keysym);
      else this.#keys.delete(event.keysym);
    } else if (event.type === "pointer") {
      if (
        !Number.isInteger(event.x) ||
        !Number.isInteger(event.y) ||
        !Number.isInteger(event.buttons) ||
        event.x < 0 ||
        event.y < 0 ||
        event.x >= this.client.width ||
        event.y >= this.client.height ||
        event.buttons < 0 ||
        event.buttons > 127
      )
        throw new ComputerRfbUnavailable();
      this.#write(() => this.client.pointerEvent(event.x, event.y, event.buttons));
      this.#pointer = event;
    } else {
      throw new ComputerRfbUnavailable();
    }
  }

  barrier(): Promise<void> {
    try {
      for (const keysym of this.#keys) {
        this.#write(() => this.client.keyEvent(keysym, false));
        this.#keys.delete(keysym);
      }
      if (this.#pointer.buttons !== 0) {
        this.#write(() => this.client.pointerEvent(this.#pointer.x, this.#pointer.y, 0));
        this.#pointer = { ...this.#pointer, buttons: 0 };
      }
      const payload = randomBytes(16);
      const id = payload.toString("hex");
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => this.#failure(), this.timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        try {
          this.#write(() => this.client.fence(fenceFlags.blockBefore, payload));
        } catch {
          this.#failure();
        }
      });
    } catch {
      this.#failure();
      return Promise.reject(new ComputerRfbUnavailable());
    }
  }

  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerRfbUnavailable());
    }
    this.#pending.clear();
    this.client.off("fence", this.#fence);
    this.client.off("close", this.#failure);
    // Retain the error handler: destroying a stream may report a final asynchronous error.
    this.client.destroy();
  }

  #fence = ({ flags, payload }: { flags: number; payload: Buffer }): void => {
    const id = payload.toString("hex");
    const pending = this.#pending.get(id);
    if (!pending || flags !== fenceFlags.blockBefore) {
      this.#failure();
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve();
  };

  #failure = (): void => {
    if (this.#closed) return;
    this.destroy();
    this.failed();
  };

  #write(send: () => void): void {
    this.#check();
    send();
    this.#check();
  }

  #check(): void {
    const stream = this.client.stream;
    if (
      this.#closed ||
      !this.client.connected ||
      !stream ||
      stream.destroyed ||
      !stream.writable ||
      stream.writableLength > MAX_BACKLOG
    )
      throw new ComputerRfbUnavailable();
  }
}
