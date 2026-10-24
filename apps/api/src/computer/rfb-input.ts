import type { Duplex } from "node:stream";
import type { BrowserSessionBinding, SessionBindingsService } from "@moss/auth";
import { RfbServerConnection, type RfbClient } from "rfb2";
import { boundedRfbInputStream } from "./rfb-input-stream.js";
import {
  ComputerInputControl,
  ComputerInputDenied,
  type ComputerAgentLease,
  type ComputerViewer
} from "./input-control.js";
import {
  ComputerRfbInputWriter,
  ComputerRfbUnavailable,
  type ComputerInputEvent
} from "./rfb-input-writer.js";

type ViewerStream = {
  readonly viewer: ComputerViewer;
  readonly stream: Duplex;
  readonly epoch: number | null;
  readonly connection: RfbServerConnection;
};

export interface ComputerRfbConnection {
  readonly viewer: ComputerViewer;
  readonly connection: RfbServerConnection;
  readonly transport: Duplex;
  readonly parserStream: Duplex;
}

/** Receiving prerequisite only; owner transport, framebuffer fan-out and lifecycle are not wired. */
export class ComputerRfbInput {
  readonly #control: ComputerInputControl;
  readonly #writer: ComputerRfbInputWriter;
  readonly #viewers = new Set<ComputerViewer>();
  readonly #streams = new Set<ViewerStream>();
  readonly #timeoutMs: number;
  #epoch = 0;
  #ready = false;
  #closed = false;
  #barrier: Promise<void> = Promise.resolve();
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(
    private readonly deps: {
      readonly ownerUserId: string;
      readonly sessions: Pick<SessionBindingsService, "assertLive">;
      readonly now: () => Date;
      readonly upstream: RfbClient;
      readonly timeoutMs?: number;
      readonly assertLifetime?: () => void;
      readonly onConnection?: (input: ComputerRfbConnection) => void;
    }
  ) {
    this.#timeoutMs = deps.timeoutMs ?? 2000;
    this.#writer = new ComputerRfbInputWriter(deps.upstream, this.#timeoutMs, () => this.#abort());
    this.#control = new ComputerInputControl({
      ownerUserId: deps.ownerUserId,
      sessions: deps.sessions,
      now: deps.now,
      onTransition: () => this.#transition()
    });
  }

  snapshot() {
    return { ...this.#control.snapshot(), receivingReady: this.#ready, closed: this.#closed };
  }

  async connect(binding: BrowserSessionBinding): Promise<ComputerViewer> {
    const viewer = await this.#bounded(this.#control.connect(binding));
    if (this.#closed) throw new ComputerRfbUnavailable();
    this.#viewers.add(viewer);
    return viewer;
  }

  async takeOver(viewer: ComputerViewer): Promise<void> {
    await this.#bounded(this.#control.takeOver(viewer));
    await this.#resume(() => this.#control.dispatchOwner(viewer, () => undefined));
  }

  async returnToMoss(viewer: ComputerViewer): Promise<void> {
    await this.#bounded(this.#control.returnToMoss(viewer));
    await this.#resumeAgent();
  }

  async closeViewer(viewer: ComputerViewer): Promise<void> {
    const epoch = this.#epoch;
    try {
      await this.#bounded(this.#control.closeViewer(viewer));
      if (epoch !== this.#epoch) await this.#resumeAgent();
    } finally {
      this.#viewers.delete(viewer);
      this.#retireViewer(viewer);
    }
  }

  disconnect(viewer: ComputerViewer): void {
    this.#control.disconnect(viewer);
    this.#viewers.delete(viewer);
    this.#retireViewer(viewer);
  }

  invalidateSession(sessionId: string): void {
    this.#control.invalidateSession(sessionId);
  }

  attachWatcher(viewer: ComputerViewer, stream: Duplex): void {
    this.#attach(viewer, stream, null);
  }

  async attachController(viewer: ComputerViewer, stream: Duplex): Promise<void> {
    const epoch = this.#epoch;
    const barrier = this.#barrier;
    try {
      this.#admit(epoch, barrier);
      await this.#bounded(this.#control.dispatchOwner(viewer, () => undefined));
      this.#admit(epoch, barrier);
      if ([...this.#streams].some((entry) => entry.epoch !== null)) {
        // A replacement parser must not inherit its predecessor's queued input or held keys.
        this.#transition();
        const replacementEpoch = this.#epoch;
        const replacementBarrier = this.#barrier;
        await this.#resume(() => this.#control.dispatchOwner(viewer, () => undefined));
        this.#admit(replacementEpoch, replacementBarrier);
      }
      this.#attach(viewer, stream, this.#epoch);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  acquireAgentLease(actorUserId: string): ComputerAgentLease {
    this.#admit(this.#epoch, this.#barrier);
    return this.#control.acquireAgentLease(actorUserId);
  }

  dispatchAgent(lease: ComputerAgentLease, event: ComputerInputEvent): Promise<void> {
    return this.#enqueue((send) => this.#control.dispatchAgent(lease, send), { ...event });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#control.close();
    this.#closed = true;
    this.#ready = false;
    this.#viewers.clear();
    for (const entry of this.#streams) this.#retire(entry);
    try {
      await this.#barrier;
    } finally {
      this.#writer.destroy();
    }
  }

  #transition(): void {
    this.#epoch += 1;
    this.#ready = false;
    for (const entry of this.#streams) {
      if (entry.epoch !== null) this.#retire(entry);
    }
    if (this.#closed) return;
    this.#barrier = this.#writer.barrier();
    void this.#barrier.catch(() => this.#abort());
  }

  #resumeAgent(): Promise<void> {
    const lease = this.#control.acquireAgentLease(this.deps.ownerUserId);
    return this.#resume(() => this.#control.dispatchAgent(lease, () => undefined));
  }

  async #resume(authorize: () => Promise<void>): Promise<void> {
    const epoch = this.#epoch;
    const barrier = this.#barrier;
    await barrier;
    this.#current(epoch, barrier);
    await this.#bounded(authorize());
    this.#current(epoch, barrier);
    this.#ready = true;
  }

  #enqueue(
    authorize: (send: () => undefined) => Promise<void>,
    event: ComputerInputEvent
  ): Promise<void> {
    const epoch = this.#epoch;
    const barrier = this.#barrier;
    try {
      this.#admit(epoch, barrier);
      if (this.#pending >= 32) {
        void this.close().catch(() => undefined);
        throw new ComputerRfbUnavailable();
      }
    } catch (error) {
      return Promise.reject(error);
    }
    this.#pending += 1;
    const result = this.#tail.then(async () => {
      this.#admit(epoch, barrier);
      await this.#bounded(
        authorize(() => {
          this.#admit(epoch, barrier);
          this.#writer.send(event);
          return undefined;
        })
      );
    });
    this.#tail = result.catch((error: unknown) => {
      if (!(error instanceof ComputerInputDenied)) void this.close().catch(() => undefined);
    });
    return result.finally(() => {
      this.#pending -= 1;
    });
  }

  #attach(viewer: ComputerViewer, stream: Duplex, epoch: number | null): void {
    if (this.#closed || !this.#viewers.has(viewer) || this.#streams.size >= 4) {
      stream.destroy();
      throw new ComputerRfbUnavailable();
    }
    const parserStream = boundedRfbInputStream(stream);
    const connection = new RfbServerConnection(parserStream, {
      width: this.deps.upstream.width,
      height: this.deps.upstream.height,
      name: "Moss Computer"
    });
    const entry = { viewer, stream, epoch, connection };
    this.#streams.add(entry);
    const timer = setTimeout(() => connection.destroy(), this.#timeoutMs);
    connection.once("ready", () => clearTimeout(timer));
    connection.on("error", () => connection.destroy());
    connection.once("close", () => {
      clearTimeout(timer);
      if (!this.#streams.delete(entry)) return;
      if (epoch !== null && epoch === this.#epoch) this.disconnect(viewer);
    });
    const input = (event: ComputerInputEvent) => {
      // A watch stream can never gain authority, even if its parser drains after takeover.
      if (epoch === null || epoch !== this.#epoch || !this.#streams.has(entry)) return;
      void this.#enqueue((send) => this.#control.dispatchOwner(viewer, send), event).catch(
        () => undefined
      );
    };
    connection.on("key", (event) => input({ type: "key", ...event }));
    connection.on("pointer", (event) => input({ type: "pointer", ...event }));
    // No clipboard/extension/raw forwarding. Only the two normalized events above reach input.
    try {
      this.deps.onConnection?.({ viewer, connection, transport: stream, parserStream });
    } catch (error) {
      this.#retire(entry);
      throw error;
    }
  }

  #retire(entry: ViewerStream): void {
    this.#streams.delete(entry);
    entry.connection.destroy();
  }

  #retireViewer(viewer: ComputerViewer): void {
    for (const entry of this.#streams) {
      if (entry.viewer === viewer) this.#retire(entry);
    }
  }

  #current(epoch: number, barrier: Promise<void>): void {
    this.deps.assertLifetime?.();
    if (this.#closed || epoch !== this.#epoch || barrier !== this.#barrier)
      throw new ComputerInputDenied();
  }

  #admit(epoch: number, barrier: Promise<void>): void {
    this.#current(epoch, barrier);
    if (!this.#ready) throw new ComputerInputDenied();
  }

  #bounded<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.close().catch(() => undefined);
        reject(new ComputerRfbUnavailable());
      }, this.#timeoutMs);
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  #abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    this.#control.close();
    this.#viewers.clear();
    for (const entry of this.#streams) this.#retire(entry);
    this.#writer.destroy();
  }
}
