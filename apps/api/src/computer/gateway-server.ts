import { dirname } from "node:path";
import { ComputerLifetimeReceiver } from "./lifetime-receiver.js";
import {
  lifetimeNow,
  lifetimePath,
  parseComputerLifetime,
  type ComputerLifetimeConfiguration
} from "./lifetime-protocol.js";
import type { Duplex } from "node:stream";
import type { ComputerReceivingGateway } from "./receiving-gateway.js";
import { createServer, type Socket } from "node:net";
import type { ComputerViewer } from "./input-control.js";
import { isUuid } from "./host-contract.js";
import { connectComputerReceivingGateway } from "./receiving-gateway.js";
import { connectComputerGuestWebSocket } from "./guest-websocket.js";
import { publishComputerSocket } from "./private-endpoint.js";
import {
  GatewayChannel,
  gatewayFields,
  gatewayOperations,
  GATEWAY_OPERATION_MS
} from "./gateway-channel.js";
import { ComputerRfbUnavailable } from "./rfb-input-writer.js";

export interface ComputerGatewayConfig {
  readonly ownerUserId: string;
  readonly guestSocketPath: string;
  readonly authSocketPath: string;
  readonly socketPath: string;
  readonly lifetime: ComputerLifetimeConfiguration;
}
type Entry = {
  id: string;
  channel: GatewayChannel;
  viewer?: ComputerViewer;
  busy: boolean;
  last: number;
  streams: Map<Socket, string>;
};

/** Opt-in executable composition; no service is installed by normal API boot. */
export async function serveComputerGateway(config: ComputerGatewayConfig) {
  if (!isUuid(config.ownerUserId)) throw new ComputerRfbUnavailable();
  const lifetimeConfig = parseComputerLifetime(config.lifetime);
  const target = lifetimePath(config.socketPath);
  if (
    [config.socketPath, config.authSocketPath, config.guestSocketPath].includes(target) ||
    dirname(target) !== dirname(config.socketPath)
  )
    throw new ComputerRfbUnavailable();
  let endpoint: Awaited<ReturnType<typeof publishComputerSocket>> | undefined;
  let lifetimeEndpoint: Awaited<ReturnType<typeof publishComputerSocket>> | undefined;
  let upstream: Duplex | undefined;
  let core: ComputerReceivingGateway | undefined;
  let lifetime: ComputerLifetimeReceiver | undefined;
  let initializing = true;
  let lifetimeActive = false;
  let lifetimeBound = false;
  const startupAt = lifetimeNow();
  const startup = setTimeout(() => {
    void close();
  }, 5000);
  const starting = (socket: Socket) => socket.destroy();
  const server = createServer(starting);
  const lifetimeServer = createServer((socket) => {
    if (closed || lifetimeBound) {
      socket.destroy();
      void close();
      return;
    }
    lifetimeBound = true;
    lifetime = new ComputerLifetimeReceiver(
      socket,
      lifetimeConfig,
      () => {
        if (closed || (lifetimeNow() >= startupAt + 5000 && !lifetimeActive)) {
          void close();
          return;
        }
        lifetimeActive = true;
        clearTimeout(startup);
      },
      retireReceiving
    );
  });
  const sockets = new Set<Socket>();
  const entries = new Map<string, Entry>();
  let streamCount = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  function retire(entry: Entry) {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    if (entry.viewer) {
      try {
        core?.disconnect(entry.viewer);
      } catch {
        /* already retired */
      }
    }
    for (const socket of entry.streams.keys()) socket.destroy();
    entry.channel.close();
  }
  let receiving: Promise<void> | undefined;
  function retireReceiving() {
    if (closed) return;
    closed = true;
    clearTimeout(startup);
    receiving = core?.close(); // Invoke synchronous epoch retirement before any ack or teardown.
    void receiving?.catch(() => {});
    for (const entry of entries.values()) retire(entry);
    for (const socket of sockets) socket.destroy();
    // Keep only the dedicated lifetime socket for its bounded fenced-ack flush.
    if (!initializing) {
      closing ??= cleanup();
      void closing.catch(() => {});
    }
  }
  async function cleanup() {
    try {
      await receiving;
    } finally {
      upstream?.destroy();
      try {
        await Promise.all([endpoint?.close(), lifetimeEndpoint?.close()]);
      } finally {
        resolveClosed();
      }
    }
  }
  function close(): Promise<void> {
    retireReceiving();
    lifetime?.close();
    return initializing ? done : (closing ??= cleanup());
  }
  server.on("error", () => {
    void close();
  });
  lifetimeServer.on("error", () => {
    void close();
  });
  try {
    endpoint = await publishComputerSocket(server, config.socketPath, ".gateway-");
    if (closed || lifetimeNow() >= startupAt + 5000) throw new ComputerRfbUnavailable();
    lifetimeEndpoint = await publishComputerSocket(lifetimeServer, target, ".lifetime-");
    if (closed || lifetimeNow() >= startupAt + 5000) throw new ComputerRfbUnavailable();
    upstream = await connectComputerGuestWebSocket(config.guestSocketPath);
    if (closed || (lifetimeNow() >= startupAt + 5000 && !lifetimeActive))
      throw new ComputerRfbUnavailable();
    core = await connectComputerReceivingGateway({ ...config, upstream });
    if (closed || (lifetimeNow() >= startupAt + 5000 && !lifetimeActive)) {
      await core.close();
      throw new ComputerRfbUnavailable();
    }
    upstream.once("close", () => {
      if (!closed) void close();
    });
  } catch (error) {
    initializing = false;
    await close();
    throw error;
  }
  initializing = false;
  const readyCore = core;
  // Core failure also destroys its supplied upstream. No polling-only process liveness inference.
  server.off("connection", starting);
  server.on("connection", (socket: Socket) => {
    if (closed || !lifetimeActive || sockets.size >= 12) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let entry: Entry | undefined;
    let header = true;
    const headerTimer = setTimeout(() => channel.close(), 2000);
    const channel = new GatewayChannel(
      socket,
      (value) => {
        if (closed) {
          channel.close();
          return;
        }
        if (header) {
          header = false;
          clearTimeout(headerTimer);
          if (
            !gatewayFields(value, "requestId,type,viewerId") ||
            value.requestId !== 1 ||
            !isUuid(value.viewerId)
          ) {
            channel.close();
            return;
          }
          if (value.type === "open") {
            if (entries.size >= 4 || entries.has(value.viewerId)) {
              channel.close();
              return;
            }
            entry = { id: value.viewerId, channel, busy: true, last: 1, streams: new Map() };
            entries.set(entry.id, entry);
            const current = entry;
            void run(current, 1, async () => {
              const viewer = await readyCore.openViewer(current.id);
              if (closed || channel.ended || entries.get(current.id) !== current) {
                try {
                  readyCore.disconnect(viewer);
                } catch {
                  /* terminal */
                }
                throw new ComputerRfbUnavailable();
              }
              current.viewer = viewer;
            });
            return;
          }
          if (value.type !== "watch" && value.type !== "control") {
            channel.close();
            return;
          }
          const owner = entries.get(value.viewerId);
          const kind = value.type;
          if (
            !owner?.viewer ||
            owner.busy ||
            owner.channel.ended ||
            streamCount >= 4 ||
            [...owner.streams].some(([s, k]) => !s.destroyed && k === kind)
          ) {
            channel.close();
            return;
          }
          const viewer = owner.viewer;
          streamCount++;
          owner.streams.set(socket, kind);
          socket.once("close", () => {
            streamCount--;
            owner.streams.delete(socket);
          });
          channel.send({ type: "ok", requestId: 1 });
          channel.takeStream();
          if (kind === "watch") {
            try {
              readyCore.attachWatcher(viewer, socket);
            } catch {
              socket.destroy();
            }
          } else {
            owner.busy = true;
            const timer = setTimeout(() => {
              void close();
            }, GATEWAY_OPERATION_MS);
            void core
              .attachController(viewer, socket)
              .catch(() => socket.destroy())
              .finally(() => {
                clearTimeout(timer);
                owner.busy = false;
              });
          }
          return;
        }
        if (
          !entry ||
          entry.busy ||
          !gatewayFields(value, "requestId,type") ||
          typeof value.requestId !== "number" ||
          value.requestId !== entry.last + 1 ||
          value.requestId > 8192 ||
          typeof value.type !== "string" ||
          !gatewayOperations.includes(value.type)
        ) {
          channel.close();
          return;
        }
        entry.last = value.requestId;
        entry.busy = true;
        const current = entry;
        const operation = value.type;
        void run(
          current,
          value.requestId,
          async () => {
            if (!current.viewer) throw new ComputerRfbUnavailable();
            if (operation === "snapshot") return readyCore.snapshot();
            if (operation === "takeOver") await readyCore.takeOver(current.viewer);
            else if (operation === "returnToMoss") await readyCore.returnToMoss(current.viewer);
            else await readyCore.closeViewer(current.viewer);
          },
          operation === "closeViewer"
        );
      },
      () => {
        clearTimeout(headerTimer);
        if (entry) retire(entry);
      }
    );
  });
  server.on("error", () => {
    void close();
  });
  async function run(
    entry: Entry,
    requestId: number,
    work: () => Promise<unknown>,
    intentionalClose = false
  ) {
    const timer = setTimeout(() => {
      void close();
    }, GATEWAY_OPERATION_MS);
    try {
      const result = await work();
      if (closed || entry.channel.ended || entries.get(entry.id) !== entry)
        throw new ComputerRfbUnavailable();
      entry.channel.send(
        result === undefined
          ? { type: "ok", requestId }
          : { type: "ok", requestId, snapshot: result }
      );
      entry.busy = false;
      if (intentionalClose) {
        entries.delete(entry.id); // Core keeps its accepted bounded grant monitor, if needed.
        for (const socket of entry.streams.keys()) socket.destroy();
        entry.channel.socket.end();
      }
    } catch {
      retire(entry);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    if (closed || readyCore.snapshot().closed) throw new ComputerRfbUnavailable();
  } catch (error) {
    await close();
    throw error;
  }
  return { close, done };
}
