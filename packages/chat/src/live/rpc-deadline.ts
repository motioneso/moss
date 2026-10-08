import { CliChatUnavailableError } from "./errors.js";
import type { RpcMethod, RpcRequest } from "./rpc-contract.js";

export interface PendingCall {
  readonly method: RpcMethod;
  readonly sessionKey?: string;
  resolve(result: unknown): void;
  reject(err: Error): void;
  /** #456 — re-arm this call's response deadline (activity-aware reset). No-op if the call has no
   *  deadline (turnTimeoutMs <= 0) or has already settled. */
  resetDeadline?: () => void;
}

/** Bounds one RPC waiter, including connection waits, without closing the shared transport. */
export function withRpcDeadline<T>(
  method: string,
  deadline: { timeoutMs: number; signal?: AbortSignal },
  connect: () => Promise<void>,
  dispatch: (resolve: (result: T) => void, reject: (error: Error) => void) => () => void
): Promise<T> {
  if (!Number.isFinite(deadline.timeoutMs) || deadline.timeoutMs <= 0) {
    return Promise.reject(new RangeError("RPC deadline must be a positive finite duration"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let removePending: (() => void) | undefined;
    const finish = (error?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deadline.signal?.removeEventListener("abort", abort);
      removePending?.();
      if (error !== undefined) reject(error);
      else resolve(result as T);
    };
    const abort = () => finish(new CliChatUnavailableError(`cli-runner ${method} cancelled`));
    const timer = setTimeout(
      () =>
        finish(
          new CliChatUnavailableError(
            `cli-runner ${method} timed out after ${deadline.timeoutMs}ms`
          )
        ),
      deadline.timeoutMs
    );
    timer.unref?.();
    deadline.signal?.addEventListener("abort", abort, { once: true });
    if (deadline.signal?.aborted) {
      abort();
      return;
    }
    void connect().then(
      () => {
        // A cancelled/expired connect waiter must never dispatch when the shared connection recovers.
        if (settled) return;
        try {
          removePending = dispatch(
            (result) => finish(undefined, result),
            (error) => finish(error)
          );
          // Also tolerate a transport settling synchronously during dispatch.
          if (settled) removePending();
        } catch (error) {
          finish(error);
        }
      },
      (error: unknown) => finish(error)
    );
  });
}

/** Register a bounded request in the same pending map used by normal response routing. */
export function callWithRpcDeadline<T>(
  deadline: { timeoutMs: number; signal?: AbortSignal },
  transport: {
    method: RpcMethod;
    sessionKey: string | undefined;
    params: unknown;
    pending: Map<number, PendingCall>;
    nextId(): number;
    connect(): Promise<void>;
    canDispatch(): boolean;
    write(frame: RpcRequest): void;
  }
): Promise<T> {
  const { method, sessionKey, params, pending } = transport;
  return withRpcDeadline<T>(
    method,
    deadline,
    () => transport.connect(),
    (resolve, reject) => {
      if (!transport.canDispatch()) {
        throw new CliChatUnavailableError("cli-runner reconciling after restart");
      }
      const id = transport.nextId();
      pending.set(id, { method, sessionKey, resolve: (result) => resolve(result as T), reject });
      try {
        transport.write({ t: "req", id, method, sessionKey, params });
      } catch (cause) {
        pending.delete(id);
        throw new CliChatUnavailableError("cli-runner socket write failed", { cause });
      }
      return () => {
        pending.delete(id);
      };
    }
  );
}
