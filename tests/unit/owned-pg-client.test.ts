import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { AbortablePgPool } from "../../packages/db/src/abortable-pg-pool.js";
import { withOwnedPgClient } from "../../packages/db/src/owned-pg-client.js";
import { withAbortableDataContext } from "../../packages/db/src/abortable-data-context.js";

const transport = vi.hoisted(() => ({
  ready: false,
  sockets: [] as { forceClose(): void; close?: () => void; closed: boolean }[],
  startups: [] as string[],
  heldQuery: "",
  queries: [] as string[],
  created: 0,
  currentQuery: "",
  forceClose: undefined as undefined | (() => void),
  close: undefined as undefined | (() => void),
  autoClose: true,
  closed: false
}));
vi.mock("node:net", async () => {
  const { Duplex } = await import("node:stream");
  return {
    Socket: class extends Duplex {
      private currentQuery = "";
      private transactionStatus = "I";
      private handle = {
        forceClose: () => this.destroy(),
        close: undefined as undefined | (() => void),
        closed: false
      };
      constructor() {
        super();
        transport.created++;
        transport.sockets.push(this.handle);
        transport.forceClose = () => this.destroy();
      }
      ref() {
        return this;
      }
      unref() {
        return this;
      }
      setNoDelay() {
        return this;
      }
      setKeepAlive() {
        return this;
      }
      connect() {
        queueMicrotask(() => this.emit("connect"));
        return this;
      }
      _read() {}
      _write(chunk: Buffer, _encoding: string, done: () => void) {
        if (chunk[0] === 0) transport.startups.push(chunk.toString());
        if (chunk[0] === 0 && transport.ready)
          queueMicrotask(() => {
            // Real pg8.21 parses AuthenticationOk + ReadyForQuery from this synthetic transport.
            this.push(Buffer.from("5200000008000000005a0000000549", "hex"));
          });
        if (chunk[0] === 81) {
          const query = chunk.subarray(5, -1).toString();
          transport.queries.push(query);
          if (query.toLowerCase() === "begin") this.transactionStatus = "T";
          if (["commit", "rollback"].includes(query.toLowerCase())) this.transactionStatus = "I";
          if (query !== transport.heldQuery)
            queueMicrotask(() => {
              const command = Buffer.from("SELECT 0\0"),
                header = Buffer.alloc(5);
              header[0] = 67;
              header.writeInt32BE(command.length + 4, 1);
              this.push(
                Buffer.concat([
                  header,
                  command,
                  Buffer.from(
                    `5a00000005${Buffer.from(this.transactionStatus).toString("hex")}`,
                    "hex"
                  )
                ])
              );
            });
        }
        if (chunk[0] === 80) {
          this.currentQuery = chunk.subarray(6).toString().split("\0")[0]!;
          transport.currentQuery = this.currentQuery;
          transport.queries.push(transport.currentQuery);
          queueMicrotask(() => this.push(Buffer.from("3100000004", "hex")));
        }
        if (chunk[0] === 66) queueMicrotask(() => this.push(Buffer.from("3200000004", "hex")));
        if (chunk[0] === 68) queueMicrotask(() => this.push(Buffer.from("6e00000004", "hex")));
        if (chunk[0] === 69 && this.currentQuery !== transport.heldQuery)
          queueMicrotask(() => {
            const command = Buffer.from("SELECT 0\0"),
              header = Buffer.alloc(5);
            header[0] = 67;
            header.writeInt32BE(command.length + 4, 1);
            this.push(Buffer.concat([header, command]));
          });
        if (chunk[0] === 83 && this.currentQuery !== transport.heldQuery)
          queueMicrotask(() =>
            this.push(
              Buffer.from(`5a00000005${Buffer.from(this.transactionStatus).toString("hex")}`, "hex")
            )
          );
        // Deliberately never acknowledge Terminate: graceful client.end alone would hang.
        if (chunk[0] !== 88) done();
      }
      _destroy(_error: Error | null, done: (error?: Error | null) => void) {
        this.handle.close = () => {
          transport.closed = true;
          this.handle.closed = true;
          done();
        };
        transport.close = this.handle.close;
        if (transport.autoClose) queueMicrotask(transport.close);
      }
    }
  };
});
const pools: AbortablePgPool[] = [];
function pool() {
  const result = new AbortablePgPool(config);
  pools.push(result);
  return result;
}
afterEach(async () => {
  for (const socket of transport.sockets) {
    socket.forceClose();
    socket.close?.();
  }
  await Promise.all(pools.splice(0).map((value) => value.close()));
  transport.sockets = [];
  transport.startups = [];
  transport.forceClose?.();
  transport.close?.();
  transport.forceClose = undefined;
  transport.currentQuery = "";
  transport.ready = false;
  transport.heldQuery = "";
  transport.queries = [];
  transport.created = 0;
  transport.close = undefined;
  transport.autoClose = true;
  transport.closed = false;
});
const config = { user: "synthetic", database: "synthetic", connectionTimeoutMillis: 1000 };
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("owned pg transport cancellation with the installed pg client", () => {
  it("rejects a pre-cancelled operation before constructing a socket", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-cancelled"));
    await expect(withOwnedPgClient(config, controller.signal, vi.fn())).rejects.toThrow(
      "pre-cancelled"
    );
    expect(transport.created).toBe(0);
  });
  it("settles a stalled connect explicitly and waits for forced socket teardown", async () => {
    transport.autoClose = false;
    const controller = new AbortController(),
      work = vi.fn();
    const pending = withOwnedPgClient(config, controller.signal, work);
    let settled = false;
    const outcome = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await tick();
    controller.abort(new Error("cancel startup"));
    await tick();
    expect(settled).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(transport.close, "owned-connect-forced-close").toBeTypeOf("function");
    transport.close!();
    await tick();
    expect(settled, "owned-connect-settled-after-close").toBe(true);
    expect(await outcome).toMatchObject({ message: "cancel startup" });
    expect(transport.closed).toBe(true);
  });
  it("cancels a held query and waits for the actual socket close", async () => {
    transport.ready = true;
    transport.autoClose = false;
    transport.heldQuery = "select held";
    const controller = new AbortController();
    const pending = withOwnedPgClient(config, controller.signal, (client) =>
      client.query("select held")
    );
    let settled = false;
    const outcome = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await tick();
    expect(transport.queries).toContain("select held");
    controller.abort();
    await tick();
    expect(settled).toBe(false);
    transport.close!();
    await outcome;
    expect(transport.closed).toBe(true);
  });
  it("force-closes even a successful idle client's stalled graceful Terminate", async () => {
    transport.ready = true;
    transport.autoClose = false;
    const pending = withOwnedPgClient(config, new AbortController().signal, async () => 42);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(transport.close, "owned-idle-forced-close").toBeTypeOf("function");
    transport.close!();
    expect(await pending).toBe(42);
    expect(transport.closed).toBe(true);
  });
  it("aborting a DataContext query cannot leave its app transaction or socket running", async () => {
    transport.ready = true;
    transport.heldQuery = "select held";
    const controller = new AbortController();
    const pending = withAbortableDataContext(
      pool(),
      {
        actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      },
      controller.signal,
      (db) => sql`select held`.execute(db.db)
    );
    let settled = false;
    const outcome = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await tick();
    await tick();
    expect(transport.queries).toContain("begin");
    expect(transport.queries).toContain("select held");
    controller.abort();
    await tick();
    expect(settled, "pooled-transaction-settled-after-abort").toBe(true);
    await outcome;
    expect(transport.closed).toBe(true);
  });
});

describe("bounded reusable maintenance connections with installed pg-pool", () => {
  const signal = () => new AbortController().signal;
  const actor = { actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  it("reuses one healthy transport across committed data contexts and explicit rollback", async () => {
    transport.ready = true;
    const value = pool();
    for (let index = 0; index < 3; index++)
      await withAbortableDataContext(value, actor, signal(), (db) =>
        sql`select healthy`.execute(db.db)
      );
    await value.withClient(signal(), async (client) => {
      await client.query("BEGIN");
      await client.query("ROLLBACK");
    });
    expect(transport.created, "pooled-healthy-transport-reused").toBe(1);
    expect(transport.queries.filter((query) => query === "commit")).toHaveLength(3);
    expect(transport.closed).toBe(false);
    expect(transport.startups[0]).toContain("statement_timeout\u00002000");
    expect(transport.startups[0]).toContain("idle_in_transaction_session_timeout\u00003000");
  });
  it("limits concurrent work to two connections and reuses them for a queued lease", async () => {
    transport.ready = true;
    const value = pool(),
      release: (() => void)[] = [];
    let active = 0,
      maximum = 0;
    const work = () =>
      value.withClient(signal(), async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => release.push(resolve));
        active--;
      });
    const pending = [work(), work(), work()];
    await tick();
    expect(release).toHaveLength(2);
    expect(transport.created).toBe(2);
    release[0]!();
    await tick();
    expect(release).toHaveLength(3);
    release[1]!();
    release[2]!();
    await Promise.all(pending);
    expect(maximum).toBe(2);
    expect(transport.created).toBe(2);
  });
  it("discards a failed transaction and uses a fresh connection after recovery", async () => {
    transport.ready = true;
    const value = pool();
    await expect(
      withAbortableDataContext(value, actor, signal(), async () => {
        throw new Error("synthetic work failure");
      })
    ).rejects.toThrow("synthetic work failure");
    expect(transport.queries).toContain("rollback");
    expect(transport.sockets[0]!.closed, "pooled-failed-lease-destroyed").toBe(true);
    await withAbortableDataContext(value, actor, signal(), (db) =>
      sql`select recovered`.execute(db.db)
    );
    expect(transport.created).toBe(2);
  });
  it("never reuses a lease returned with an unfinished transaction", async () => {
    transport.ready = true;
    const value = pool();
    const failure = await value
      .withClient(signal(), (client) => client.query("BEGIN"))
      .catch((error: unknown) => error);
    expect(failure, "pooled-open-transaction-rejected").toMatchObject({
      message: "Database lease returned with an open transaction"
    });
    expect(transport.sockets[0]!.closed).toBe(true);
    await value.withClient(signal(), async () => 42);
    expect(transport.created).toBe(2);
  });
  it("waits for cancelled query teardown and never returns that lease to the pool", async () => {
    transport.ready = true;
    transport.autoClose = false;
    transport.heldQuery = "select held";
    const value = pool(),
      controller = new AbortController();
    let settled = false;
    const outcome = value
      .withClient(controller.signal, (client) => client.query("select held"))
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await tick();
    controller.abort();
    await tick();
    expect(settled).toBe(false);
    expect(transport.close, "pooled-abort-forced-close").toBeTypeOf("function");
    transport.close!();
    await outcome;
    expect(transport.sockets[0]!.closed).toBe(true);
    transport.autoClose = true;
    await value.withClient(signal(), async () => 42);
    expect(transport.created, "pooled-cancelled-lease-not-reused").toBe(2);
  });
  it("bounds an exhausted pool without running queued work and recovers after release", async () => {
    transport.ready = true;
    const value = pool(),
      releases: (() => void)[] = [];
    const hold = () =>
      value.withClient(signal(), () => new Promise<void>((resolve) => releases.push(resolve)));
    const first = hold(),
      second = hold();
    await tick();
    const work = vi.fn();
    await expect(value.withClient(signal(), work)).rejects.toThrow(
      "timeout exceeded when trying to connect"
    );
    expect(work).not.toHaveBeenCalled();
    expect(transport.created).toBe(2);
    expect(transport.sockets.every((socket) => !socket.closed)).toBe(true);
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    await value.withClient(signal(), async () => 42);
    expect(transport.created).toBe(2);
  });
  it("does not run cancelled work after a queued acquisition and leaves other leases alone", async () => {
    transport.ready = true;
    const value = pool(),
      controller = new AbortController(),
      releases: (() => void)[] = [];
    const hold = () =>
      value.withClient(signal(), () => new Promise<void>((resolve) => releases.push(resolve)));
    const first = hold(),
      second = hold();
    await tick();
    const work = vi.fn();
    const cancelled = value.withClient(controller.signal, work).catch((error: unknown) => error);
    controller.abort(new Error("cancel queued"));
    releases[0]!();
    await first;
    expect(await cancelled).toMatchObject({ message: "cancel queued" });
    expect(work, "pooled-cancelled-acquisition-no-work").not.toHaveBeenCalled();
    expect(transport.sockets[0]!.closed).toBe(true);
    expect(transport.sockets[1]!.closed).toBe(false);
    releases[1]!();
    await second;
  });
  it("bounds stalled startup and waits for its local transport close before rejection", async () => {
    transport.autoClose = false;
    const value = pool(),
      controller = new AbortController(),
      work = vi.fn();
    let settled = false;
    const outcome = value.withClient(controller.signal, work).catch((error: unknown) => {
      settled = true;
      return error;
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(transport.close, "pooled-startup-timeout-destroy").toBeTypeOf("function");
    expect(settled).toBe(false);
    transport.close!();
    await outcome;
    expect(work).not.toHaveBeenCalled();
    expect(transport.sockets[0]!.closed).toBe(true);
  });
  it("pool shutdown waits for the actual close of healthy idle transports", async () => {
    transport.ready = true;
    transport.autoClose = false;
    const value = pool();
    await value.withClient(signal(), async () => 42);
    pools.splice(pools.indexOf(value), 1);
    let settled = false;
    const closing = value.close().then(() => {
      settled = true;
    });
    await tick();
    expect(settled, "pooled-shutdown-waits-close").toBe(false);
    expect(transport.close, "pooled-idle-forced-close").toBeTypeOf("function");
    transport.close!();
    await closing;
    expect(settled).toBe(true);
    expect(transport.closed).toBe(true);
  });
});
