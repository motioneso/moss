import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { withOwnedPgClient } from "../../packages/db/src/owned-pg-client.js";
import { withAbortableDataContext } from "../../packages/db/src/abortable-data-context.js";

const transport = vi.hoisted(() => ({
  ready: false,
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
      constructor() {
        super();
        transport.created++;
        transport.forceClose = () => this.destroy();
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
        if (chunk[0] === 0 && transport.ready)
          queueMicrotask(() => {
            // Real pg8.21 parses AuthenticationOk + ReadyForQuery from this synthetic transport.
            this.push(Buffer.from("5200000008000000005a0000000549", "hex"));
          });
        if (chunk[0] === 81) {
          const query = chunk.subarray(5, -1).toString();
          transport.queries.push(query);
          if (query !== transport.heldQuery)
            queueMicrotask(() => {
              const command = Buffer.from("SELECT 0\0"),
                header = Buffer.alloc(5);
              header[0] = 67;
              header.writeInt32BE(command.length + 4, 1);
              this.push(Buffer.concat([header, command, Buffer.from("5a0000000554", "hex")]));
            });
        }
        if (chunk[0] === 80) {
          transport.currentQuery = chunk.subarray(6).toString().split("\0")[0]!;
          transport.queries.push(transport.currentQuery);
          queueMicrotask(() => this.push(Buffer.from("3100000004", "hex")));
        }
        if (chunk[0] === 66) queueMicrotask(() => this.push(Buffer.from("3200000004", "hex")));
        if (chunk[0] === 68) queueMicrotask(() => this.push(Buffer.from("6e00000004", "hex")));
        if (chunk[0] === 69 && transport.currentQuery !== transport.heldQuery)
          queueMicrotask(() => {
            const command = Buffer.from("SELECT 0\0"),
              header = Buffer.alloc(5);
            header[0] = 67;
            header.writeInt32BE(command.length + 4, 1);
            this.push(Buffer.concat([header, command]));
          });
        if (chunk[0] === 83 && transport.currentQuery !== transport.heldQuery)
          queueMicrotask(() => this.push(Buffer.from("5a0000000554", "hex")));
        // Deliberately never acknowledge Terminate: graceful client.end alone would hang.
        if (chunk[0] !== 88) done();
      }
      _destroy(_error: Error | null, done: (error?: Error | null) => void) {
        transport.close = () => {
          transport.closed = true;
          done();
        };
        if (transport.autoClose) queueMicrotask(transport.close);
      }
    }
  };
});
afterEach(() => {
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
      "postgres://synthetic@unused/synthetic",
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
    expect(settled, "owned-transaction-settled-after-abort").toBe(true);
    await outcome;
    expect(transport.closed).toBe(true);
  });
});
