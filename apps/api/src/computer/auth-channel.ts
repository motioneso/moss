import type { Socket } from "node:net";
import type { BrowserSessionBinding } from "@moss/auth";
import { isRecord, isUuid } from "./host-contract.js";

export const AUTH_DEADLINE_MS = 2000;
export const AUTH_PENDING_LIMIT = 32;
export const AUTH_REQUEST_LIMIT = 8192;
const FRAME_LIMIT = 4096;
const BACKLOG_LIMIT = 65_536;

export class ComputerAuthUnavailable extends Error {
  constructor() {
    super("Computer auth unavailable");
  }
}

export interface AuthBinding {
  readonly actorUserId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly expiresAt: number;
}

export function fields(value: unknown, keys: string): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === keys;
}

export function parseAuthBinding(value: unknown): AuthBinding {
  if (
    !fields(value, "actorUserId,expiresAt,requestId,sessionId") ||
    !isUuid(value.actorUserId) ||
    !isUuid(value.sessionId) ||
    typeof value.requestId !== "string" ||
    value.requestId.length > 128 ||
    !value.requestId.length ||
    !Number.isSafeInteger(value.expiresAt) ||
    typeof value.expiresAt !== "number" ||
    value.expiresAt <= Date.now()
  )
    throw new ComputerAuthUnavailable();
  return Object.freeze({
    actorUserId: value.actorUserId,
    sessionId: value.sessionId,
    requestId: value.requestId,
    expiresAt: value.expiresAt
  });
}

export function browserBinding(binding: AuthBinding): BrowserSessionBinding {
  return { ...binding, expiresAt: new Date(binding.expiresAt) };
}

/** Handles expiries longer than Node's maximum timer duration without premature expiry. */
export function expireAt(expiresAt: number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  schedule();
  return () => clearTimeout(timer);
}

/** Fixed private protocol. Never forwards raw bytes to a guest or accepts browser auth. */
export class ComputerAuthChannel {
  #partial = Buffer.alloc(0);
  constructor(
    readonly socket: Socket,
    receive: (value: unknown) => void,
    fail: () => void
  ) {
    socket.on("data", (chunk: Buffer) => {
      try {
        let offset = 0;
        let count = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const piece = chunk.subarray(offset, end);
          if (this.#partial.length + piece.length > FRAME_LIMIT)
            throw new ComputerAuthUnavailable();
          this.#partial = Buffer.concat([this.#partial, piece]);
          if (newline < 0) break;
          if (++count > AUTH_PENDING_LIMIT) throw new ComputerAuthUnavailable();
          const frame = this.#partial;
          this.#partial = Buffer.alloc(0);
          receive(JSON.parse(frame.toString("utf8")));
          if (socket.destroyed) break;
          offset = newline + 1;
        }
      } catch {
        fail();
      }
    });
    socket.on("error", fail);
    socket.on("end", fail);
    socket.on("close", fail);
  }

  send(value: unknown): void {
    const frame = Buffer.from(JSON.stringify(value) + "\n");
    if (
      frame.length > FRAME_LIMIT ||
      this.socket.destroyed ||
      !this.socket.writable ||
      this.socket.writableLength + frame.length > BACKLOG_LIMIT
    )
      throw new ComputerAuthUnavailable();
    this.socket.write(frame);
    if (this.socket.writableLength > BACKLOG_LIMIT) throw new ComputerAuthUnavailable();
  }
}
