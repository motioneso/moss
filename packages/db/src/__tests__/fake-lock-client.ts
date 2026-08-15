// Shared test double for the #1632 cluster-DDL-lock caller wiring. Mirrors the FakeClient
// shape in cluster-ddl-lock.test.ts, but reusable across the ported call sites so each one can
// assert that its protected DDL ran on the lock-owner session rather than a second connection.
import type { ClusterDdlLockClient, WithClusterDdlLockOptions } from "../cluster-ddl-lock.js";

export const FAKE_OWNER_PID = 4242;

export class FakeLockClient implements ClusterDdlLockClient {
  readonly queries: Array<{ text: string; params?: readonly unknown[] }> = [];
  connectCalls = 0;
  endCalls = 0;
  private readonly listeners = new Set<(error: Error) => void>();

  constructor(private readonly rowsFor: (text: string) => unknown[] = () => []) {}

  get texts(): string[] {
    return this.queries.map((call) => call.text);
  }

  async connect(): Promise<void> {
    this.connectCalls++;
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }> {
    this.queries.push({ text, params });
    return { rows: this.rowsFor(text) as T[] };
  }

  async end(): Promise<void> {
    this.endCalls++;
  }

  on(event: "error", listener: (error: Error) => void): this {
    this.listeners.add(listener);
    return this;
  }

  removeListener(event: "error", listener: (error: Error) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  emitError(error: Error): void {
    for (const listener of this.listeners) listener(error);
  }
}

export interface FakeLockHarness {
  readonly owner: FakeLockClient;
  readonly probe: FakeLockClient;
  /** Connection strings the lock asked for, in creation order (owner first, then probe). */
  readonly connectionStrings: string[];
  readonly options: WithClusterDdlLockOptions;
}

/**
 * A harness whose owner client acquires the lock cleanly and whose probe always reports the
 * owner backend alive. `livenessIntervalMs` is deliberately far longer than any test body so the
 * heartbeat never fires — these tests pin caller wiring, not the primitive's liveness logic.
 */
export function createFakeLockHarness(): FakeLockHarness {
  const owner = new FakeLockClient((text) =>
    text.includes("pg_backend_pid") ? [{ pid: FAKE_OWNER_PID }] : []
  );
  const probe = new FakeLockClient((text) =>
    text.includes("pg_stat_activity") ? [{ pid: FAKE_OWNER_PID }] : []
  );
  const connectionStrings: string[] = [];

  return {
    owner,
    probe,
    connectionStrings,
    options: {
      env: {} as NodeJS.ProcessEnv,
      livenessIntervalMs: 5000,
      createOwnerClient: (connectionString) => {
        connectionStrings.push(connectionString);
        return owner;
      },
      createProbeClient: (connectionString) => {
        connectionStrings.push(connectionString);
        return probe;
      }
    }
  };
}
