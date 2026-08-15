import pg from "pg";

import { resolveMossEnv } from "./env.js";

const { Client } = pg;

/**
 * #1632: liveness-aware cluster-global DDL lock. Superseded design vs. the original #1013
 * closure attempt — that helper ran protected DDL through a session separate from the
 * lock-holder, so backend death silently released the lock while the DDL session kept going
 * unaware. This helper runs the protected callback on the SAME session that holds the
 * session-level advisory lock: any query on that connection after the backend dies fails
 * immediately, and an idle callback's owner loss is bounded by an independent heartbeat probe.
 *
 * Not reentrant: nested or concurrent calls from the same process are refused synchronously.
 * Wrapped sections must be sequential siblings.
 */

export interface ClusterDdlLockClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

export type ClusterDdlLockLivenessSignal = "connection-error" | "heartbeat";

export type ClusterDdlLockDiagnosticEvent =
  | { readonly type: "acquired"; readonly ownerPid: number }
  | { readonly type: "released"; readonly released: boolean };

export interface WithClusterDdlLockOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly lockKey?: string;
  readonly lockTimeoutMs?: number;
  readonly livenessIntervalMs?: number;
  readonly createOwnerClient?: (connectionString: string) => ClusterDdlLockClient;
  readonly createProbeClient?: (connectionString: string) => ClusterDdlLockClient;
  readonly onDiagnostic?: (event: ClusterDdlLockDiagnosticEvent) => void;
}

export class ClusterDdlLockAcquisitionError extends Error {
  constructor(cause: unknown) {
    super(
      `[cluster-ddl-lock] refusing: failed to acquire the cluster-global DDL lock — ${describeCause(cause)}`
    );
    this.name = "ClusterDdlLockAcquisitionError";
    this.cause = cause;
  }
}

export class ClusterDdlLockLivenessLostError extends Error {
  readonly ownerPid: number;
  readonly signal: ClusterDdlLockLivenessSignal;

  constructor(ownerPid: number, signal: ClusterDdlLockLivenessSignal, cause?: unknown) {
    super(
      `[cluster-ddl-lock] lock owner session (pid ${ownerPid}) liveness lost via ${signal} — ` +
        "refusing to treat protected work as safely serialized"
    );
    this.name = "ClusterDdlLockLivenessLostError";
    this.ownerPid = ownerPid;
    this.signal = signal;
    this.cause = cause;
  }
}

export class ClusterDdlLockCleanupError extends Error {
  constructor(cause: unknown) {
    super(
      "[cluster-ddl-lock] protected callback succeeded but releasing the lock failed — " +
        `cannot prove a clean release — ${describeCause(cause)}`
    );
    this.name = "ClusterDdlLockCleanupError";
    this.cause = cause;
  }
}

export class ClusterDdlLockReentrancyError extends Error {
  constructor() {
    super(
      "[cluster-ddl-lock] refusing: withClusterDdlLock is not reentrant — nested or concurrent " +
        "calls from the same process must be sequential siblings, not nested"
    );
    this.name = "ClusterDdlLockReentrancyError";
  }
}

export const DEFAULT_CLUSTER_LOCK_DATABASE = "postgres";
export const DEFAULT_CLUSTER_LOCK_KEY = "jarv1s:cluster-ddl";
export const DEFAULT_LIVENESS_INTERVAL_MS = 250;
export const MIN_LIVENESS_INTERVAL_MS = 50;
export const MAX_LIVENESS_INTERVAL_MS = 5000;

/**
 * Preserves the current maintenance-DB targeting behavior: swap the bootstrap connection
 * string's database to `JARVIS_CLUSTER_LOCK_DATABASE` (default `postgres`), keeping every other
 * part of the URL — including query parameters — unchanged.
 */
export function getClusterLockDatabaseUrl(
  bootstrapConnectionString: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const url = new URL(bootstrapConnectionString);
  const databaseName =
    resolveMossEnv(env, "JARVIS_CLUSTER_LOCK_DATABASE") ?? DEFAULT_CLUSTER_LOCK_DATABASE;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function defaultCreateClient(connectionString: string): ClusterDdlLockClient {
  return new Client({ connectionString }) as unknown as ClusterDdlLockClient;
}

function safeDiagnosticEmitter(
  onDiagnostic: ((event: ClusterDdlLockDiagnosticEvent) => void) | undefined
): (event: ClusterDdlLockDiagnosticEvent) => void {
  return (event) => {
    if (!onDiagnostic) return;
    try {
      onDiagnostic(event);
    } catch {
      // Diagnostics are observational only — a sink failure must not alter outcome semantics.
    }
  };
}

async function safeEnd(client: ClusterDdlLockClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // Best-effort only; the backend may already be gone.
  }
}

let locking = false;

export async function withClusterDdlLock<T>(
  bootstrapConnectionString: string,
  fn: (client: ClusterDdlLockClient) => Promise<T>,
  options: WithClusterDdlLockOptions = {}
): Promise<T> {
  const livenessIntervalMs = options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
  if (
    livenessIntervalMs < MIN_LIVENESS_INTERVAL_MS ||
    livenessIntervalMs > MAX_LIVENESS_INTERVAL_MS
  ) {
    throw new Error(
      `[cluster-ddl-lock] livenessIntervalMs (${livenessIntervalMs}) must be between ` +
        `${MIN_LIVENESS_INTERVAL_MS} and ${MAX_LIVENESS_INTERVAL_MS}ms`
    );
  }

  if (locking) {
    throw new ClusterDdlLockReentrancyError();
  }
  locking = true;

  try {
    const env = options.env ?? process.env;
    const lockKey = options.lockKey ?? DEFAULT_CLUSTER_LOCK_KEY;
    const connectionString = getClusterLockDatabaseUrl(bootstrapConnectionString, env);
    const createOwnerClient = options.createOwnerClient ?? defaultCreateClient;
    const createProbeClient = options.createProbeClient ?? defaultCreateClient;
    const emitDiagnostic = safeDiagnosticEmitter(options.onDiagnostic);

    const ownerClient = createOwnerClient(connectionString);
    let ownerPid: number;
    try {
      await ownerClient.connect();
      if (options.lockTimeoutMs !== undefined) {
        await ownerClient.query(`SET statement_timeout = ${Math.trunc(options.lockTimeoutMs)}`);
      }
      await ownerClient.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      const identity = await ownerClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = identity.rows[0]?.pid;
      if (pid === undefined) {
        throw new Error("pg_backend_pid() returned no rows");
      }
      ownerPid = pid;
    } catch (cause) {
      await safeEnd(ownerClient);
      throw new ClusterDdlLockAcquisitionError(cause);
    }

    emitDiagnostic({ type: "acquired", ownerPid });

    return await runProtected(fn, {
      ownerClient,
      ownerPid,
      lockKey,
      livenessIntervalMs,
      createProbeClient,
      connectionString,
      emitDiagnostic
    });
  } finally {
    locking = false;
  }
}

interface RunProtectedContext {
  readonly ownerClient: ClusterDdlLockClient;
  readonly ownerPid: number;
  readonly lockKey: string;
  readonly livenessIntervalMs: number;
  readonly createProbeClient: (connectionString: string) => ClusterDdlLockClient;
  readonly connectionString: string;
  readonly emitDiagnostic: (event: ClusterDdlLockDiagnosticEvent) => void;
}

interface LivenessLoss {
  readonly signal: ClusterDdlLockLivenessSignal;
  readonly cause?: unknown;
}

async function runProtected<T>(
  fn: (client: ClusterDdlLockClient) => Promise<T>,
  ctx: RunProtectedContext
): Promise<T> {
  const {
    ownerClient,
    ownerPid,
    lockKey,
    livenessIntervalMs,
    createProbeClient,
    connectionString,
    emitDiagnostic
  } = ctx;

  let livenessLoss: LivenessLoss | undefined;
  let resolveLivenessLost: (loss: LivenessLoss) => void = () => {};
  const livenessLostPromise = new Promise<LivenessLoss>((resolve) => {
    resolveLivenessLost = resolve;
  });

  const recordLivenessLoss = (loss: LivenessLoss): void => {
    if (livenessLoss) return;
    livenessLoss = loss;
    resolveLivenessLost(loss);
  };

  const onOwnerError = (error: Error): void => {
    recordLivenessLoss({ signal: "connection-error", cause: error });
  };
  ownerClient.on("error", onOwnerError);

  const probeClient = createProbeClient(connectionString);
  let probeConnected = false;
  let probeTimer: ReturnType<typeof setInterval> | undefined;

  const stopProbe = async (): Promise<void> => {
    if (probeTimer !== undefined) {
      clearInterval(probeTimer);
      probeTimer = undefined;
    }
    if (probeConnected) {
      await safeEnd(probeClient);
    }
  };

  try {
    await probeClient.connect();
    probeConnected = true;
    probeTimer = setInterval(() => {
      void (async () => {
        if (livenessLoss) return;
        try {
          const result = await probeClient.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE pid = $1",
            [ownerPid]
          );
          if (result.rows.length === 0) {
            recordLivenessLoss({ signal: "heartbeat" });
          }
        } catch (cause) {
          recordLivenessLoss({ signal: "heartbeat", cause });
        }
      })();
    }, livenessIntervalMs);
  } catch (cause) {
    recordLivenessLoss({ signal: "heartbeat", cause });
  }

  let callbackResult:
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown }
    | undefined;

  const callbackPromise = (async () => fn(ownerClient))().then(
    (value) => {
      callbackResult = { status: "fulfilled", value };
      return value;
    },
    (reason: unknown) => {
      callbackResult = { status: "rejected", reason };
      throw reason;
    }
  );
  callbackPromise.catch(() => {
    // Observed via callbackResult; prevents an unhandled rejection when liveness wins the race.
  });

  const outcome = await Promise.race([
    callbackPromise.then(
      (value) => ({ kind: "callback" as const, value }),
      (reason: unknown) => ({ kind: "callback-error" as const, reason })
    ),
    livenessLostPromise.then((loss) => ({ kind: "liveness-lost" as const, loss }))
  ]);

  ownerClient.removeListener("error", onOwnerError);
  await stopProbe();

  if (outcome.kind === "liveness-lost") {
    // Give a callback failure that settled in the same tick a chance to be observed so it can
    // be combined, without waiting indefinitely for a callback that may never settle.
    await Promise.resolve();
    await Promise.resolve();

    const livenessError = new ClusterDdlLockLivenessLostError(
      ownerPid,
      outcome.loss.signal,
      outcome.loss.cause
    );
    await safeEnd(ownerClient);

    if (callbackResult?.status === "rejected") {
      throw new AggregateError(
        [livenessError, callbackResult.reason],
        "[cluster-ddl-lock] lock liveness was lost and the protected callback also failed"
      );
    }
    throw livenessError;
  }

  if (outcome.kind === "callback-error") {
    try {
      await releaseLock(ownerClient, lockKey, emitDiagnostic);
    } catch (cleanupCause) {
      throw new AggregateError(
        [outcome.reason, new ClusterDdlLockCleanupError(cleanupCause)],
        "[cluster-ddl-lock] the protected callback failed and releasing the lock also failed",
        { cause: cleanupCause }
      );
    }
    throw outcome.reason;
  }

  try {
    await releaseLock(ownerClient, lockKey, emitDiagnostic);
  } catch (cleanupCause) {
    throw new ClusterDdlLockCleanupError(cleanupCause);
  }
  return outcome.value;
}

async function releaseLock(
  ownerClient: ClusterDdlLockClient,
  lockKey: string,
  emitDiagnostic: (event: ClusterDdlLockDiagnosticEvent) => void
): Promise<void> {
  const released = await (async () => {
    try {
      await ownerClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      return true;
    } finally {
      await safeEnd(ownerClient);
    }
  })();
  emitDiagnostic({ type: "released", released });
}
