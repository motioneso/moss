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
  const starting = (socket: Socket) => socket.destroy();
  const server = createServer(starting);
  const endpoint = await publishComputerSocket(server, config.socketPath, ".gateway-");
  const upstream = await connectComputerGuestWebSocket(config.guestSocketPath).catch(
    async (error: unknown) => {
      await endpoint.close();
      throw error;
    }
  );
  const core = await connectComputerReceivingGateway({ ...config, upstream }).catch(
    async (error: unknown) => {
      upstream.destroy();
      await endpoint.close();
      throw error;
    }
  );
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
        core.disconnect(entry.viewer);
      } catch {
        /* already retired */
      }
    }
    for (const socket of entry.streams.keys()) socket.destroy();
    entry.channel.close();
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    const receiving = core.close(); // Fence synchronously, before closing any transport.
    for (const entry of entries.values()) retire(entry);
    for (const socket of sockets) socket.destroy();
    closing = (async () => {
      await receiving;
      upstream.destroy();
      await endpoint.close();
    })().finally(resolveClosed);
    return closing;
  }
  upstream.once("close", () => {
    void close();
  });
  // Core failure also destroys its supplied upstream. No polling-only process liveness inference.
  server.off("connection", starting);
  server.on("connection", (socket: Socket) => {
    if (closed || sockets.size >= 12) {
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
              const viewer = await core.openViewer(current.id);
              if (closed || channel.ended || entries.get(current.id) !== current) {
                try {
                  core.disconnect(viewer);
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
              core.attachWatcher(viewer, socket);
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
            if (operation === "snapshot") return core.snapshot();
            if (operation === "takeOver") await core.takeOver(current.viewer);
            else if (operation === "returnToMoss") await core.returnToMoss(current.viewer);
            else await core.closeViewer(current.viewer);
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
    if (closed || core.snapshot().closed) throw new ComputerRfbUnavailable();
  } catch (error) {
    await close();
    throw error;
  }
  return { close, done };
}
