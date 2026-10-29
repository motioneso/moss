import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BrowserSessionBinding, SessionBindingsService } from "@moss/auth";
import { isUuid } from "./host-contract.js";
import {
  AUTH_DEADLINE_MS,
  AUTH_PENDING_LIMIT,
  AUTH_REQUEST_LIMIT,
  ComputerAuthChannel,
  ComputerAuthUnavailable,
  browserBinding,
  expireAt,
  fields,
  parseAuthBinding,
  type AuthBinding
} from "./auth-channel.js";

export interface ComputerAuthSession extends Pick<SessionBindingsService, "assertLive"> {
  readonly binding: BrowserSessionBinding;
  close(): void;
}

/** One issued viewer lifetime. Loss never retries or resurrects a former receiving capability. */
export function connectComputerAuth(deps: {
  socketPath: string;
  viewerId: string;
  ownerUserId: string;
  onInvalidate: () => void;
}): Promise<ComputerAuthSession> {
  if (!isUuid(deps.viewerId) || !isUuid(deps.ownerUserId))
    return Promise.reject(new ComputerAuthUnavailable());
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: deps.socketPath });
    let ended = false;
    let binding: AuthBinding | undefined;
    let requests = 0;
    let cancelExpiry = () => {};
    let poll: ReturnType<typeof setInterval> | undefined;
    const pending = new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        deadline: number;
      }
    >();
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(handshakeTimer);
      clearInterval(poll);
      cancelExpiry();
      socket.destroy();
      const error = new ComputerAuthUnavailable();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      reject(error);
      // Mark ended and reject waiters before synchronously fencing the receiver.
      try {
        deps.onInvalidate();
      } catch {
        /* channel stays terminal even if caller cleanup fails */
      }
    };
    const handshakeDeadline = performance.now() + AUTH_DEADLINE_MS;
    const handshakeTimer = setTimeout(end, AUTH_DEADLINE_MS);
    const channel = new ComputerAuthChannel(
      socket,
      (value) => {
        if (ended) return;
        if (fields(value, "type") && value.type === "ended") {
          end();
          return;
        }
        if (
          !fields(value, "binding,requestId,type") ||
          value.type !== "live" ||
          !isUuid(value.requestId)
        ) {
          end();
          return;
        }
        const entry = pending.get(value.requestId);
        if (
          !entry ||
          performance.now() >= entry.deadline ||
          (!binding && performance.now() >= handshakeDeadline)
        ) {
          end();
          return;
        }
        const fresh = parseAuthBinding(value.binding);
        if (
          fresh.actorUserId !== deps.ownerUserId ||
          (binding &&
            (fresh.actorUserId !== binding.actorUserId ||
              fresh.sessionId !== binding.sessionId ||
              fresh.requestId !== binding.requestId ||
              fresh.expiresAt !== binding.expiresAt))
        ) {
          end();
          return;
        }
        binding = fresh;
        pending.delete(value.requestId);
        clearTimeout(entry.timer);
        entry.resolve();
      },
      end
    );
    const check = (initial = false): Promise<void> => {
      if (
        ended ||
        (binding && binding.expiresAt <= Date.now()) ||
        pending.size >= AUTH_PENDING_LIMIT ||
        requests >= AUTH_REQUEST_LIMIT
      ) {
        end();
        return Promise.reject(new ComputerAuthUnavailable());
      }
      const requestId = randomUUID();
      requests++;
      return new Promise<void>((done, fail) => {
        pending.set(requestId, {
          resolve: done,
          reject: fail,
          deadline: performance.now() + AUTH_DEADLINE_MS,
          timer: setTimeout(end, AUTH_DEADLINE_MS)
        });
        try {
          channel.send(
            initial
              ? { type: "bind", requestId, viewerId: deps.viewerId }
              : { type: "check", requestId }
          );
        } catch {
          end();
        }
      });
    };
    socket.once("connect", () => {
      void check(true).then(() => {
        if (ended || !binding || binding.expiresAt <= Date.now()) {
          end();
          return;
        }
        clearTimeout(handshakeTimer);
        cancelExpiry = expireAt(binding.expiresAt, end);
        poll = setInterval(() => {
          void check().catch(end);
        }, AUTH_DEADLINE_MS);
        poll.unref();
        const fixed = binding;
        resolve({
          get binding() {
            return browserBinding(fixed);
          },
          async assertLive(input) {
            if (
              input.actorUserId !== fixed.actorUserId ||
              input.sessionId !== fixed.sessionId ||
              input.deviceId
            ) {
              end();
              throw new ComputerAuthUnavailable();
            }
            await check();
            if (ended || fixed.expiresAt <= Date.now()) {
              end();
              throw new ComputerAuthUnavailable();
            }
          },
          close: end
        });
      }, end);
    });
  });
}
