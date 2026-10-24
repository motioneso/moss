import type { Duplex } from "node:stream";
import { encodings, RfbClient } from "rfb2";
import { connectComputerAuth, type ComputerAuthSession } from "./auth-client.js";
import { boundedComputerGuest } from "./guest-envelope.js";
import { ComputerReceivingFrames } from "./receiving-frames.js";
import { ComputerRfbInput } from "./rfb-input.js";
import {
  ComputerInputDenied,
  type ComputerAgentLease,
  type ComputerViewer
} from "./input-control.js";
import { ComputerRfbUnavailable, type ComputerInputEvent } from "./rfb-input-writer.js";

type ViewerEntry = {
  readonly id: string;
  auth?: ComputerAuthSession;
  viewer?: ComputerViewer;
  visual: boolean;
  retired: boolean;
};
type ViewerStream = { entry: ViewerEntry; controlling: boolean; expectedLoss: boolean };

/** Internal core: must run inside the separately qualified gateway, never ordinary API boot. */
export async function connectComputerReceivingGateway(deps: {
  ownerUserId: string;
  authSocketPath: string;
  upstream: Duplex;
}): Promise<ComputerReceivingGateway> {
  const stream = boundedComputerGuest(deps.upstream);
  const upstream = new RfbClient({
    stream,
    security: [1],
    encodings: [encodings.raw, encodings.pseudoFence],
    pixelFormat: "bgrx",
    initialUpdate: false,
    autoUpdate: false,
    timeout: 2000,
    maxClipboardBytes: 0
  });
  await new Promise<void>((resolve, reject) => {
    let connected = false;
    const timer = setTimeout(failed, 2000);
    function failed() {
      clearTimeout(timer);
      upstream.destroy();
      reject(new ComputerRfbUnavailable());
    }
    function ready() {
      if (!connected || !upstream.supports.fence) return;
      clearTimeout(timer);
      upstream.off("close", failed);
      upstream.off("fence", ready);
      resolve();
    }
    upstream.on("error", failed);
    upstream.once("close", failed);
    upstream.once("connect", () => {
      connected = true;
      ready();
    });
    upstream.on("fence", ready);
  });
  try {
    return new ComputerReceivingGateway(deps, upstream);
  } catch {
    upstream.destroy();
    throw new ComputerRfbUnavailable();
  }
}

export class ComputerReceivingGateway {
  readonly #receiver: ComputerRfbInput;
  readonly #frames: ComputerReceivingFrames;
  readonly #entries = new Set<ViewerEntry>();
  readonly #streams = new Map<Duplex, ViewerStream>();
  readonly #renderTimer: ReturnType<typeof setInterval>;
  #frameTimer?: ReturnType<typeof setTimeout>;
  #frameDeadline?: ReturnType<typeof setTimeout>;
  #outstanding = false;
  #closed = false;
  #busy = false;
  #grant?: ViewerEntry;
  #owner?: ViewerEntry;
  #closing?: Promise<void>;

  constructor(
    private readonly deps: { ownerUserId: string; authSocketPath: string },
    private readonly upstream: RfbClient
  ) {
    this.#frames = new ComputerReceivingFrames(upstream.width, upstream.height);
    this.#receiver = new ComputerRfbInput({
      ownerUserId: deps.ownerUserId,
      upstream,
      now: () => new Date(),
      sessions: {
        assertLive: async (binding) => {
          const entry = [...this.#entries].find(
            (candidate) =>
              !candidate.retired &&
              candidate.auth?.binding.actorUserId === binding.actorUserId &&
              candidate.auth.binding.sessionId === binding.sessionId
          );
          if (!entry?.auth) throw new ComputerInputDenied();
          await entry.auth.assertLive(binding);
        }
      },
      onConnection: (input) => this.#frames.attach(input)
    });
    upstream.on("error", () => {
      void this.close();
    });
    upstream.once("close", () => {
      void this.close();
    });
    upstream.on("update", (update) => {
      if (this.#closed) return;
      try {
        if (!this.#outstanding) throw new ComputerRfbUnavailable();
        this.#outstanding = false;
        clearTimeout(this.#frameDeadline);
        this.#frames.apply(update);
        this.#frameTimer = setTimeout(() => this.#requestFrame(), 200);
      } catch {
        void this.close();
      }
    });
    this.#renderTimer = setInterval(() => this.#frames.render(), 200);
    this.#renderTimer.unref();
    this.#requestFrame();
  }

  snapshot() {
    return { ...this.#receiver.snapshot(), frameReady: !this.#closed && this.#frames.ready };
  }

  async openViewer(viewerId: string): Promise<ComputerViewer> {
    if (
      this.#closed ||
      this.#entries.size >= 4 ||
      [...this.#entries].some((e) => e.id === viewerId)
    )
      throw new ComputerRfbUnavailable();
    const entry: ViewerEntry = { id: viewerId, visual: true, retired: false };
    this.#entries.add(entry); // Reserve before any async auth work.
    try {
      const auth = await connectComputerAuth({
        ...this.deps,
        viewerId,
        socketPath: this.deps.authSocketPath,
        onInvalidate: () => this.#authLost(entry)
      });
      entry.auth = auth;
      if (entry.retired) auth.close();
      this.#current(entry);
      const viewer = await this.#receiver.connect(auth.binding);
      entry.viewer = viewer;
      this.#current(entry);
      return viewer;
    } catch {
      if (entry.viewer) this.#receiver.disconnect(entry.viewer);
      this.#retire(entry);
      throw new ComputerRfbUnavailable();
    }
  }

  attachWatcher(viewer: ComputerViewer, stream: Duplex): void {
    const entry = this.#entry(viewer);
    this.#track(entry, stream, false);
    try {
      this.#receiver.attachWatcher(viewer, stream);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  takeOver(viewer: ComputerViewer): Promise<void> {
    return this.#change(viewer, async () => {
      await this.#receiver.takeOver(viewer);
      this.#current(this.#entry(viewer));
      this.#owner = this.#entry(viewer);
      this.#setGrant(undefined);
    });
  }

  attachController(viewer: ComputerViewer, stream: Duplex): Promise<void> {
    return this.#change(viewer, async (entry) => {
      this.#track(entry, stream, true);
      try {
        await this.#receiver.attachController(viewer, stream);
      } catch (error) {
        stream.destroy();
        throw error;
      }
      this.#current(entry);
    });
  }

  returnToMoss(viewer: ComputerViewer): Promise<void> {
    return this.#change(viewer, async (entry) => {
      await this.#receiver.returnToMoss(viewer);
      this.#current(entry);
      this.#owner = undefined;
      this.#setGrant(entry);
    });
  }

  closeViewer(viewer: ComputerViewer): Promise<void> {
    return this.#change(viewer, async (entry) => {
      const controlling = this.#owner === entry && this.#receiver.snapshot().mode === "owner";
      try {
        await this.#receiver.closeViewer(viewer);
        this.#current(entry);
        if (controlling) {
          this.#owner = undefined;
          this.#setGrant(entry);
        }
      } finally {
        this.#detach(entry);
      }
    });
  }

  disconnect(viewer: ComputerViewer): void {
    const entry = this.#entry(viewer);
    this.#receiver.disconnect(viewer);
    this.#detach(entry);
  }

  acquireAgentLease(): ComputerAgentLease {
    return this.#receiver.acquireAgentLease(this.deps.ownerUserId);
  }

  dispatchAgent(lease: ComputerAgentLease, event: ComputerInputEvent): Promise<void> {
    return this.#receiver.dispatchAgent(lease, event);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#renderTimer);
    clearTimeout(this.#frameTimer);
    clearTimeout(this.#frameDeadline);
    // close() advances the receiving epoch and releases pressed inputs before its first await.
    const receiving = this.#receiver.close();
    this.#frames.close();
    this.#grant = undefined;
    for (const entry of this.#entries) this.#retire(entry);
    this.#closing = receiving.catch(() => undefined).finally(() => this.upstream.destroy());
    return this.#closing;
  }

  #requestFrame(): void {
    if (this.#closed) return;
    this.#outstanding = true;
    this.#frameDeadline = setTimeout(() => {
      void this.close();
    }, 2000);
    if (
      !this.upstream.connected ||
      !this.upstream.stream?.writable ||
      this.upstream.stream.writableLength > 65_526
    ) {
      void this.close();
      return;
    }
    this.upstream.requestUpdate(this.#frames.ready);
  }

  #entry(viewer: ComputerViewer): ViewerEntry {
    const entry = [...this.#entries].find((candidate) => candidate.viewer === viewer);
    if (!entry) throw new ComputerInputDenied();
    this.#current(entry);
    return entry;
  }

  #current(entry: ViewerEntry): void {
    if (this.#closed || entry.retired || !entry.visual || !this.#entries.has(entry))
      throw new ComputerInputDenied();
  }

  async #change(
    viewer: ComputerViewer,
    work: (entry: ViewerEntry) => Promise<void>
  ): Promise<void> {
    const entry = this.#entry(viewer);
    if (this.#busy) throw new ComputerInputDenied();
    this.#busy = true;
    for (const state of this.#streams.values()) {
      if (state.controlling) state.expectedLoss = true;
    }
    try {
      await work(entry);
      if (this.#closed) throw new ComputerInputDenied();
    } finally {
      this.#busy = false;
      for (const [stream, state] of this.#streams) {
        if (!stream.destroyed) state.expectedLoss = false;
      }
    }
  }

  #track(entry: ViewerEntry, stream: Duplex, controlling: boolean): void {
    if (this.#streams.has(stream)) throw new ComputerRfbUnavailable();
    const state = { entry, controlling, expectedLoss: false };
    this.#streams.set(stream, state);
    stream.once("close", () => {
      this.#streams.delete(stream);
      if (!state.expectedLoss && !entry.retired && entry.visual) {
        if (entry.viewer) this.#receiver.disconnect(entry.viewer);
        this.#detach(entry);
      }
    });
  }

  #detach(entry: ViewerEntry): void {
    entry.visual = false;
    if (this.#owner === entry) this.#owner = undefined;
    for (const [stream, state] of this.#streams) {
      if (state.entry === entry) {
        state.expectedLoss = true;
        stream.destroy();
      }
    }
    if (this.#grant !== entry) this.#retire(entry);
  }

  #setGrant(entry: ViewerEntry | undefined): void {
    const old = this.#grant;
    this.#grant = entry;
    // Local monitor cleanup cannot invalidate a newer grant from the same login session.
    if (old && old !== entry && !old.visual) this.#retire(old);
  }

  #authLost(entry: ViewerEntry): void {
    if (entry.retired) return; // Only deliberate local close marks this before channel.close().
    const sessionId = entry.auth?.binding.sessionId;
    if (sessionId) {
      this.#receiver.invalidateSession(sessionId);
      for (const candidate of this.#entries) {
        if (candidate.auth?.binding.sessionId === sessionId) this.#retire(candidate);
      }
    } else this.#retire(entry);
  }

  #retire(entry: ViewerEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.#owner === entry) this.#owner = undefined;
    this.#entries.delete(entry);
    if (this.#grant === entry) this.#grant = undefined;
    if (entry.viewer) this.#receiver.disconnect(entry.viewer);
    for (const [stream, state] of this.#streams) {
      if (state.entry === entry) {
        state.expectedLoss = true;
        stream.destroy();
      }
    }
    entry.auth?.close();
  }
}
