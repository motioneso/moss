import pg from "pg";
import { getOwnedPgClientConstructor, type OwnedPgClient } from "./owned-pg-client.js";

/** Bounded reusable leases; failed/cancelled work destroys its transport before returning. */
export class AbortablePgPool {
  private pool?: pg.Pool;
  private closed = false;
  private closing?: Promise<void>;
  private readonly clients = new Set<OwnedPgClient>();

  constructor(private readonly config: pg.PoolConfig) {}

  private getPool(): pg.Pool {
    if (this.closed) throw new Error("Cannot use a closed maintenance pool");
    if (this.pool) return this.pool;
    const clients = this.clients;
    const OwnedClient = getOwnedPgClientConstructor();
    this.pool = new pg.Pool({
      ...this.config,
      max: 2,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      idle_in_transaction_session_timeout: 3000,
      // Client-side query timeouts reject without draining the server query.
      query_timeout: 0,
      Client: class extends OwnedClient {
        constructor(options: pg.ClientConfig = {}) {
          super(options);
          clients.add(this);
          this.once("end", () => clients.delete(this));
        }
      }
    });
    // pg-pool discards idle clients after server disconnects; next checkout reconnects.
    this.pool.on("error", () => undefined);
    return this.pool;
  }

  async withClient<T>(signal: AbortSignal, work: (client: pg.Client) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    // pg-pool bounds both startup and its wait queue to one second. Await checkout even
    // after cancellation so no orphaned acquisition can later run work or leak a lease.
    const client = await this.getPool().connect();
    const OwnedClient = getOwnedPgClientConstructor();
    if (!(client instanceof OwnedClient)) {
      client.release(true);
      throw new Error("Abortable pool requires an owned transport");
    }
    let reusable = false;
    const abort = () => void client.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await work(client);
      signal.throwIfAborted();
      if (!client.isIdle()) throw new Error("Database lease returned with an open transaction");
      reusable = true;
      return result;
    } finally {
      const discard = !reusable || signal.aborted;
      // release(true) invokes OwnedPgClient.end, and pg-pool only wakes its waiters
      // after that callback. Explicitly await the same teardown before reporting done.
      client.release(discard);
      if (discard) await client.destroy();
      signal.removeEventListener("abort", abort);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= this.drain());
  }

  private async drain(): Promise<void> {
    if (!this.pool) return;
    const clients = [...this.clients];
    await this.pool.end();
    // Pool.end can settle once its list is empty, before all remove callbacks finish.
    await Promise.all(clients.map((client) => client.destroy()));
  }
}
