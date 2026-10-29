import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { SessionInvalidations } from "../../packages/auth/src/session-invalidations.js";
import { serveComputerAuth } from "../../apps/api/src/computer/auth-server.js";
import { connectComputerAuth } from "../../apps/api/src/computer/auth-client.js";
import { ComputerAuthChannel } from "../../apps/api/src/computer/auth-channel.js";

export const OWNER = "10000000-0000-4000-8000-000000000001";
export const FOREIGN = "20000000-0000-4000-8000-000000000002";
export const SESSION = "30000000-0000-4000-8000-000000000003";
export const binding = (sessionId = SESSION, expiresAt = Date.now() + 60_000) => ({
  actorUserId: OWNER,
  sessionId,
  expiresAt: new Date(expiresAt),
  requestId: "synthetic-request"
});
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function authFixture() {
  const root = await mkdtemp(join(tmpdir(), "moss-auth-"));
  const socketPath = join(root, "auth.sock");
  const invalidations = new SessionInvalidations();
  const assertLive = vi.fn<() => Promise<void>>(async () => {});
  const server = await serveComputerAuth({
    socketPath,
    ownerUserId: OWNER,
    invalidations,
    sessions: { assertLive }
  });
  const clients: { close(): void }[] = [];
  return {
    root,
    socketPath,
    invalidations,
    assertLive,
    server,
    async connect(b = binding(), onInvalidate = vi.fn()) {
      const id = server.issue(b);
      const client = await connectComputerAuth({
        socketPath,
        viewerId: id,
        ownerUserId: OWNER,
        onInvalidate
      });
      clients.push(client);
      return client;
    },
    async raw() {
      const socket = createConnection({ path: socketPath });
      socket.on("error", () => {});
      clients.push({ close: () => socket.destroy() });
      await once(socket, "connect");
      return socket;
    },
    async close() {
      for (const client of clients) client.close();
      await server.close();
      invalidations.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function fakeAuthServer(
  receive: (value: unknown, channel: ComputerAuthChannel) => void
) {
  const root = await mkdtemp(join(tmpdir(), "moss-auth-reply-"));
  const socketPath = join(root, "auth.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const channel = new ComputerAuthChannel(
      socket,
      (value) => receive(value, channel),
      () => socket.destroy()
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function bindFrame(viewerId: string) {
  return { type: "bind", viewerId, requestId: randomUUID() };
}

export function liveFrame(requestId: unknown, b = binding()) {
  return { type: "live", requestId, binding: { ...b, expiresAt: b.expiresAt.getTime() } };
}
