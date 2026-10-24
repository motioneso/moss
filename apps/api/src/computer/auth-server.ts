import { randomUUID } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type {
  BrowserSessionBinding,
  SessionBindingsService,
  SessionInvalidations
} from "@moss/auth";
import { isUuid } from "./host-contract.js";
import {
  AUTH_DEADLINE_MS,
  AUTH_PENDING_LIMIT,
  AUTH_REQUEST_LIMIT,
  ComputerAuthChannel,
  ComputerAuthUnavailable,
  expireAt,
  fields,
  parseAuthBinding,
  type AuthBinding
} from "./auth-channel.js";

interface IssuedBinding {
  readonly binding: AuthBinding;
  cancelExpiry: () => void;
  retire: () => void;
  claimed: boolean;
}

/** Opt-in API-side private service. No listener is installed by ordinary server startup. */
export async function serveComputerAuth(deps: {
  socketPath: string;
  ownerUserId: string;
  sessions: Pick<SessionBindingsService, "assertLive">;
  invalidations: SessionInvalidations;
}) {
  await assertPrivateParent(deps.socketPath);
  if (!isUuid(deps.ownerUserId)) throw new ComputerAuthUnavailable();
  const issued = new Map<string, IssuedBinding>();
  const sockets = new Set<Socket>();
  let closed = false;
  let authWork = 0;

  const retire = (id: string, entry: IssuedBinding) => {
    if (issued.get(id) !== entry) return;
    issued.delete(id);
    entry.cancelExpiry();
    entry.retire();
  };
  const unsubscribe = deps.invalidations.subscribe((event) => {
    for (const [id, entry] of issued) {
      const b = entry.binding;
      if (
        event === null ||
        (event.actorUserId === b.actorUserId &&
          ("sessionId" in event
            ? event.sessionId === b.sessionId
            : event.exceptSessionId !== b.sessionId))
      )
        retire(id, entry);
    }
    if (event === null) {
      closed = true;
      for (const socket of sockets) socket.destroy();
    }
  });

  const server = createServer((socket) => {
    if (closed || sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let entry: IssuedBinding | undefined;
    let viewerId = "";
    let ended = false;
    let pending = 0;
    const ids = new Set<string>();
    const deadlines = new Set<ReturnType<typeof setTimeout>>();
    const stop = () => {
      if (ended) return;
      ended = true;
      for (const timer of deadlines) clearTimeout(timer);
      deadlines.clear();
      if (entry) retire(viewerId, entry);
      socket.destroy();
    };
    socket.once("close", () => {
      sockets.delete(socket);
    });
    const bindTimer = setTimeout(stop, AUTH_DEADLINE_MS);
    deadlines.add(bindTimer);
    const channel = new ComputerAuthChannel(
      socket,
      (value) => {
        if (ended) return;
        const bindingFrame = !entry;
        if (
          !(bindingFrame
            ? fields(value, "requestId,type,viewerId")
            : fields(value, "requestId,type")) ||
          !isUuid(value.requestId) ||
          ids.has(value.requestId) ||
          ids.size >= AUTH_REQUEST_LIMIT ||
          value.type !== (bindingFrame ? "bind" : "check")
        ) {
          stop();
          return;
        }
        if (bindingFrame) {
          if (!isUuid(value.viewerId)) {
            stop();
            return;
          }
          const candidate = issued.get(value.viewerId);
          if (!candidate || candidate.claimed) {
            stop();
            return;
          }
          viewerId = value.viewerId;
          entry = candidate;
          entry.claimed = true;
          entry.retire = () => {
            // Registry/epoch is retired before writing the notification or closing the stream.
            try {
              channel.send({ type: "ended" });
            } catch {
              /* disconnect is also terminal */
            }
            stop();
          };
        }
        const current = entry;
        if (!current || current.binding.expiresAt <= Date.now() || authWork >= AUTH_PENDING_LIMIT) {
          stop();
          return;
        }
        ids.add(value.requestId);
        const requestId = value.requestId;
        authWork++;
        pending++;
        const deadline = performance.now() + AUTH_DEADLINE_MS;
        const timer = setTimeout(stop, AUTH_DEADLINE_MS);
        deadlines.add(timer);
        void (async () => {
          try {
            await deps.sessions.assertLive({
              actorUserId: current.binding.actorUserId,
              sessionId: current.binding.sessionId
            });
            if (performance.now() >= deadline) {
              stop();
              return;
            }
            if (
              ended ||
              closed ||
              issued.get(viewerId) !== current ||
              current.binding.expiresAt <= Date.now()
            )
              return;
            channel.send({ type: "live", requestId, binding: current.binding });
            if (bindingFrame) {
              clearTimeout(bindTimer);
              deadlines.delete(bindTimer);
            }
          } catch {
            stop();
          } finally {
            // Closing a socket does not cancel a database promise or release its work budget.
            authWork--;
            pending--;
            clearTimeout(timer);
            deadlines.delete(timer);
          }
        })();
        if (pending > AUTH_PENDING_LIMIT) stop();
      },
      stop
    );
  });
  // createServer never unlinks an existing Unix endpoint.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(deps.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(deps.socketPath, 0o600);
  } catch (error) {
    unsubscribe();
    server.close();
    throw error;
  }
  const identity = await lstat(deps.socketPath);
  return {
    issue(binding: BrowserSessionBinding): string {
      if (closed || issued.size >= 4 || binding.actorUserId !== deps.ownerUserId)
        throw new ComputerAuthUnavailable();
      const fixed = parseAuthBinding({ ...binding, expiresAt: binding.expiresAt.getTime() });
      const id = randomUUID();
      const entry: IssuedBinding = {
        binding: fixed,
        claimed: false,
        retire: () => {},
        cancelExpiry: () => {}
      };
      issued.set(id, entry);
      entry.cancelExpiry = expireAt(fixed.expiresAt, () => retire(id, entry));
      return id;
    },
    release(viewerId: string): void {
      const entry = issued.get(viewerId);
      if (entry) retire(viewerId, entry);
    },
    async close(): Promise<void> {
      closed = true;
      unsubscribe();
      for (const [id, entry] of issued) retire(id, entry);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Node removes the bound socket on server.close; never remove a replacement endpoint.
      const remaining = await lstat(deps.socketPath).catch(() => null);
      if (remaining && remaining.dev === identity.dev && remaining.ino === identity.ino)
        await unlink(deps.socketPath);
    }
  };
}

async function assertPrivateParent(path: string): Promise<void> {
  const uid = process.getuid!();
  const parent = dirname(path);
  if (!isAbsolute(path) || parent === path || (await realpath(parent)) !== parent)
    throw new ComputerAuthUnavailable();
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
    throw new ComputerAuthUnavailable();
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    const s = await lstat(ancestor);
    if (
      ![0, uid].includes(s.uid) ||
      ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000) !== 0))
    )
      throw new ComputerAuthUnavailable();
    if (dirname(ancestor) === ancestor) break;
  }
}
