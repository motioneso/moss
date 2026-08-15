import pg from "pg";

import { resolveMossEnv } from "./env.js";

const { Client } = pg;

/**
 * #1632: liveness-aware cluster-global DDL lock, dual-session design.
 *
 * PostgreSQL advisory-lock tags include the database OID, so a lock taken on the caller's target
 * database excludes nothing on any other database. Cluster-global exclusion therefore requires
 * the lock to live on ONE agreed database — the maintenance database (`JARVIS_CLUSTER_LOCK_DATABASE`,
 * default `postgres`). But DDL only affects the database its session is connected to, so the
 * protected callback cannot run there. Hence two sessions:
 *
 * - the **lock session**, on the maintenance database, holds the session-level advisory lock and
 *   does nothing else;
 * - the **DDL session**, on the caller's target database, runs the callback's statements.
 *
 * Splitting them reopens the question this feature exists to answer — how do we know the lock was
 * still held while the DDL ran? Three channels answer it, all raising
 * `ClusterDdlLockLivenessLostError`: the lock session's `'error'` event, a `SELECT 1` heartbeat
 * every `livenessIntervalMs` (a rejection *or* an unsettled previous tick is loss, bounding
 * detection at ~2 intervals), and — decisively — one fresh `SELECT 1` after the callback fulfills,
 * before success is reported and before unlock. node-postgres never auto-reconnects and a session
 * lock lives exactly as long as its backend, so a passing final check proves the backend lived
 * continuously from acquisition through the callback's last statement: every committed statement
 * ran under the lock. A run whose lock died can never report success.
 *
 * The callback receives a guard around the DDL session, not the session itself: once loss is
 * recorded, further statements never reach the wire, and the statement in flight at that instant
 * is raced against the loss and its result discarded. That in-flight statement may still commit
 * server-side — a residual window bounded by detection latency plus statement duration, inherent
 * to advisory locking without transactional fence tokens, and deliberately not papered over by
 * wrapping the callback in a transaction (callers manage their own).
 *
 * DDL-session death is an ordinary callback failure, not liveness loss: the lock still holds.
 *
 * Not reentrant: nested or concurrent calls from the same process are refused synchronously.
 * Wrapped sections must be sequential siblings.
 */

/** A driver connection the helper owns end to end. Both DI seams produce these. */
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

/**
 * What the protected callback gets: query access to the DDL session, guarded by the lock's
 * liveness state. Deliberately not `ClusterDdlLockClient` — connection lifecycle belongs to the
 * helper, and a callback that could `end()` the session would break the ownership contract.
 */
export interface ClusterDdlSessionClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export type ClusterDdlLockLivenessSignal = "connection-error" | "heartbeat" | "final-check";

export type ClusterDdlLockDiagnosticEvent =
  | { readonly type: "acquired"; readonly ownerPid: number }
  | { readonly type: "heartbeat"; readonly ownerPid: number }
  | { readonly type: "released"; readonly released: boolean };

export interface WithClusterDdlLockOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly lockKey?: string;
  readonly lockTimeoutMs?: number;
  readonly livenessIntervalMs?: number;
  readonly createLockClient?: (connectionString: string) => ClusterDdlLockClient;
  readonly createDdlClient?: (connectionString: string) => ClusterDdlLockClient;
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
      `[cluster-ddl-lock] lock session (pid ${ownerPid}) liveness lost via ${signal} — ` +
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

const LIVENESS_PROBE_SQL = "SELECT 1";

/**
 * The lock session's connection string: the bootstrap URL with its database swapped to
 * `JARVIS_CLUSTER_LOCK_DATABASE` (default `postgres`), every other part — query parameters
 * included — unchanged. Every participant must land on the same database or the advisory-lock
 * tags differ and nothing is excluded.
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

/** True when `reason` is `target` or carries it anywhere in its `cause` chain. */
function isCausedBy(reason: unknown, target: Error): boolean {
  let current: unknown = reason;
  for (let depth = 0; depth < 16 && current instanceof Error; depth += 1) {
    if (current === target) return true;
    current = current.cause;
  }
  return false;
}

let locking = false;

export async function withClusterDdlLock<T>(
  bootstrapConnectionString: string,
  fn: (client: ClusterDdlSessionClient) => Promise<T>,
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
    const createLockClient = options.createLockClient ?? defaultCreateClient;
    const createDdlClient = options.createDdlClient ?? defaultCreateClient;
    const emitDiagnostic = safeDiagnosticEmitter(options.onDiagnostic);

    const lockClient = createLockClient(getClusterLockDatabaseUrl(bootstrapConnectionString, env));
    let lockAcquired = false;
    let lockPid: number;
    try {
      await lockClient.connect();
      if (options.lockTimeoutMs !== undefined) {
        await lockClient.query(`SET statement_timeout = ${Math.trunc(options.lockTimeoutMs)}`);
      }
      await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      lockAcquired = true;
      const identity = await lockClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = identity.rows[0]?.pid;
      if (pid === undefined) {
        throw new Error("pg_backend_pid() returned no rows");
      }
      lockPid = pid;
    } catch (cause) {
      throw await abortAcquisition(lockClient, lockKey, lockAcquired, cause);
    }

    emitDiagnostic({ type: "acquired", ownerPid: lockPid });

    const ddlClient = createDdlClient(bootstrapConnectionString);
    try {
      await ddlClient.connect();
    } catch (cause) {
      await safeEnd(ddlClient);
      throw await abortAcquisition(lockClient, lockKey, true, cause);
    }

    return await runProtected(fn, {
      lockClient,
      ddlClient,
      lockPid,
      lockKey,
      livenessIntervalMs,
      emitDiagnostic
    });
  } finally {
    locking = false;
  }
}

/**
 * Unwinds a failure that happened before the protected callback ever started: release whatever
 * was acquired, then report an acquisition error — surfacing a release failure alongside it
 * rather than hiding it behind the original cause.
 */
async function abortAcquisition(
  lockClient: ClusterDdlLockClient,
  lockKey: string,
  lockAcquired: boolean,
  cause: unknown
): Promise<Error> {
  let cleanupError: ClusterDdlLockCleanupError | undefined;
  if (lockAcquired) {
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    } catch (cleanupCause) {
      cleanupError = new ClusterDdlLockCleanupError(cleanupCause);
    }
  }
  await safeEnd(lockClient);

  const acquisitionError = new ClusterDdlLockAcquisitionError(cause);
  if (!cleanupError) return acquisitionError;
  return new AggregateError(
    [acquisitionError, cleanupError],
    "[cluster-ddl-lock] acquisition failed and releasing what was acquired also failed"
  );
}

interface RunProtectedContext {
  readonly lockClient: ClusterDdlLockClient;
  readonly ddlClient: ClusterDdlLockClient;
  readonly lockPid: number;
  readonly lockKey: string;
  readonly livenessIntervalMs: number;
  readonly emitDiagnostic: (event: ClusterDdlLockDiagnosticEvent) => void;
}

async function runProtected<T>(
  fn: (client: ClusterDdlSessionClient) => Promise<T>,
  ctx: RunProtectedContext
): Promise<T> {
  const { lockClient, ddlClient, lockPid, lockKey, livenessIntervalMs, emitDiagnostic } = ctx;

  // The liveness error is built once, at the instant loss is recorded, and is the same instance
  // the guard rejects with — which is how outer settlement recognises "the callback failed
  // because of our own guard" and reports it alone instead of a duplicate-member aggregate.
  let livenessError: ClusterDdlLockLivenessLostError | undefined;
  let resolveLivenessLost: (error: ClusterDdlLockLivenessLostError) => void = () => {};
  const livenessLostPromise = new Promise<ClusterDdlLockLivenessLostError>((resolve) => {
    resolveLivenessLost = resolve;
  });

  const recordLivenessLoss = (signal: ClusterDdlLockLivenessSignal, cause?: unknown): void => {
    if (livenessError) return;
    livenessError = new ClusterDdlLockLivenessLostError(lockPid, signal, cause);
    resolveLivenessLost(livenessError);
  };

  const onLockError = (error: Error): void => {
    recordLivenessLoss("connection-error", error);
  };
  lockClient.on("error", onLockError);

  // An unhandled 'error' event kills the process, so the DDL session needs a listener even though
  // its death is not liveness loss; the captured error surfaces on the next guarded query.
  let ddlError: Error | undefined;
  const onDdlError = (error: Error): void => {
    ddlError ??= error;
  };
  ddlClient.on("error", onDdlError);

  let heartbeatInFlight = false;
  const heartbeatTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (livenessError) return;
    if (heartbeatInFlight) {
      // The previous probe never came back: a hung socket or stalled server holds the lock's fate
      // in limbo, which we treat as loss rather than piling on another query.
      recordLivenessLoss(
        "heartbeat",
        new Error(`heartbeat did not settle within ${livenessIntervalMs}ms`)
      );
      return;
    }
    heartbeatInFlight = true;
    void lockClient.query(LIVENESS_PROBE_SQL).then(
      () => {
        heartbeatInFlight = false;
        if (!livenessError) emitDiagnostic({ type: "heartbeat", ownerPid: lockPid });
      },
      (cause: unknown) => {
        heartbeatInFlight = false;
        recordLivenessLoss("heartbeat", cause);
      }
    );
  }, livenessIntervalMs);

  const guardedClient: ClusterDdlSessionClient = {
    async query<R = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[]
    ): Promise<{ rows: R[] }> {
      if (livenessError) throw livenessError;
      if (ddlError) throw ddlError;
      return await Promise.race([
        livenessLostPromise.then((error) => {
          throw error;
        }),
        ddlClient.query<R>(text, params)
      ]);
    }
  };

  let settled:
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown }
    | undefined;

  const callbackPromise = (async () => fn(guardedClient))().then(
    (value) => {
      settled = { status: "fulfilled", value };
    },
    (reason: unknown) => {
      settled = { status: "rejected", reason };
    }
  );

  await Promise.race([callbackPromise, livenessLostPromise]);

  lockClient.removeListener("error", onLockError);
  clearInterval(heartbeatTimer);

  if (!settled) {
    // Liveness loss won the race. Yield one macrotask so a callback that is about to fail on the
    // guard's own rejection is observed and reported as itself rather than as a bare liveness
    // error — without waiting on a callback that may never settle at all.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!livenessError && settled?.status === "fulfilled") {
    try {
      await lockClient.query(LIVENESS_PROBE_SQL);
    } catch (cause) {
      recordLivenessLoss("final-check", cause);
    }
  }

  if (livenessError) {
    // Never unlock: either the backend is gone (PostgreSQL released it already) or we cannot
    // prove it is ours to release, and a blind unlock could free a lock a newer owner now holds.
    ddlClient.removeListener("error", onDdlError);
    await safeEnd(lockClient);
    await safeEnd(ddlClient);

    if (settled?.status === "rejected" && !isCausedBy(settled.reason, livenessError)) {
      throw new AggregateError(
        [livenessError, settled.reason],
        "[cluster-ddl-lock] lock liveness was lost and the protected callback also failed"
      );
    }
    throw livenessError;
  }

  /* c8 ignore next */
  if (!settled) throw new Error("[cluster-ddl-lock] unreachable: callback did not settle");

  if (settled.status === "rejected") {
    const { reason } = settled;
    try {
      await releaseLock(lockClient, lockKey, emitDiagnostic);
    } catch (cleanupCause) {
      throw new AggregateError(
        [reason, new ClusterDdlLockCleanupError(cleanupCause)],
        "[cluster-ddl-lock] the protected callback failed and releasing the lock also failed",
        { cause: cleanupCause }
      );
    } finally {
      ddlClient.removeListener("error", onDdlError);
      await safeEnd(ddlClient);
    }
    throw reason;
  }

  try {
    await releaseLock(lockClient, lockKey, emitDiagnostic);
  } catch (cleanupCause) {
    throw new ClusterDdlLockCleanupError(cleanupCause);
  } finally {
    ddlClient.removeListener("error", onDdlError);
    await safeEnd(ddlClient);
  }
  return settled.value;
}

async function releaseLock(
  lockClient: ClusterDdlLockClient,
  lockKey: string,
  emitDiagnostic: (event: ClusterDdlLockDiagnosticEvent) => void
): Promise<void> {
  const released = await (async () => {
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      return true;
    } finally {
      await safeEnd(lockClient);
    }
  })();
  emitDiagnostic({ type: "released", released });
}
