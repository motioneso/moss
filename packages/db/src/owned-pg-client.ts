import { Socket } from "node:net";
import pg from "pg";

/** Own the TCP transport even when pg wraps it in TLS or graceful Terminate stalls. */
export class OwnedPgClient extends pg.Client {
  private readonly socket: Socket;
  private readonly closed: Promise<void>;
  private ending?: Promise<void>;
  private transactionStatus?: string;

  constructor(config: pg.ClientConfig = {}) {
    const socket = new Socket();
    super({ ...config, stream: () => socket });
    this.socket = socket;
    this.closed = new Promise<void>((resolve) => socket.once("close", resolve));
    // Awaited connect/query report errors; avoid uncaught errors on a leased idle client.
    this.on("error", () => undefined);
    this.connection.on("readyForQuery", (message: { status: string }) => {
      this.transactionStatus = message.status;
    });
  }

  isIdle(): boolean {
    return !this.ending && this.transactionStatus === "I";
  }

  override connect(): Promise<pg.Client>;
  override connect(callback: Parameters<pg.Client["connect"]>[0]): void;
  override connect(callback?: Parameters<pg.Client["connect"]>[0]): Promise<pg.Client> | void {
    const connected = new Promise<pg.Client>((resolve, reject) => {
      super.connect((error?: Error) => {
        if (error) void this.destroy().then(() => reject(error));
        else resolve(this);
      });
    });
    if (callback) {
      // pg invokes these Node-style callbacks with null on success, despite @types/pg.
      void connected.then(
        () => Reflect.apply(callback, this, [null, this]),
        (error: unknown) => Reflect.apply(callback, this, [error])
      );
    } else return connected;
  }

  override end(): Promise<void>;
  override end(callback: (error: Error) => void): void;
  override end(callback?: (error: Error) => void): Promise<void> | void {
    const ending = this.destroy();
    if (callback) void ending.then(() => Reflect.apply(callback, this, []));
    else return ending;
  }

  destroy(): Promise<void> {
    if (!this.ending) {
      const stopped = super.end();
      // pg.end alone may wait for a peer even during startup or idle shutdown.
      this.socket.destroy();
      this.ending = Promise.allSettled([stopped, this.closed]).then(() => undefined);
    }
    return this.ending;
  }
}

/** Abort closes the owned transport and waits for the work and local socket teardown. */
export async function withOwnedPgClient<T>(
  config: pg.ClientConfig,
  signal: AbortSignal,
  work: (client: pg.Client) => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  const client = new OwnedPgClient(config);
  let rejectConnect: ((error: unknown) => void) | undefined;
  const abort = () => {
    // pg skips its connect callback after _ending becomes true. Settle our bridge explicitly.
    rejectConnect?.(signal.reason);
    void client.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      rejectConnect = reject;
      client.connect((error?: Error) => {
        rejectConnect = undefined;
        if (error) reject(error);
        else resolve();
      });
    });
    signal.throwIfAborted();
    const result = await work(client);
    signal.throwIfAborted();
    return result;
  } finally {
    await client.destroy();
    signal.removeEventListener("abort", abort);
  }
}
