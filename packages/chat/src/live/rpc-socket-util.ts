import { connect, type Socket } from "node:net";

/** §3.5 backoff: 250ms → 2s, exponential with full jitter. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** (attempt - 1));
  return Math.floor(minMs + Math.random() * Math.max(0, ceiling - minMs));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const onError = (err: Error): void => {
      socket.off("connect", onConnect);
      reject(err);
    };
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
