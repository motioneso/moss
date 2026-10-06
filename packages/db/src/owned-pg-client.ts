import { Socket } from "node:net";
import pg from "pg";

/** Own the transport as well as the client, including stalled startup and final teardown. */
export async function withOwnedPgClient<T>(
  config: pg.ClientConfig,
  signal: AbortSignal,
  work: (client: pg.Client) => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  const socket = new Socket();
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  const client = new pg.Client({ ...config, stream: () => socket });
  // Awaited connect/query report errors; prevent an unexpected idle error becoming uncaught.
  client.on("error", () => undefined);
  let rejectConnect: ((error: unknown) => void) | undefined;
  let ending: Promise<void> | undefined;
  const end = () => {
    if (!ending) {
      const stopped = client.end();
      // pg.end alone may wait for a peer even during startup or idle shutdown.
      socket.destroy();
      ending = Promise.allSettled([stopped, closed]).then(() => undefined);
    }
    return ending;
  };
  const abort = () => {
    // pg skips its connect callback after _ending becomes true. Settle our bridge explicitly.
    rejectConnect?.(signal.reason);
    void end();
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
    await end();
    signal.removeEventListener("abort", abort);
  }
}
