import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:net";

const LOCK_WAIT_MS = 300_000;
const LOCK_POLL_MS = 100;
const LOCK_PREFIX = "\0moss-embed-";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function closeServer(server: Server, allowNotRunning = false): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (!error || (allowNotRunning && errorCode(error) === "ERR_SERVER_NOT_RUNNING")) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

async function tryListen(address: string): Promise<Server | null> {
  const server = createServer((socket) => socket.destroy());
  return new Promise<Server | null>((resolvePromise, reject) => {
    let settled = false;
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      resolvePromise(server);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      server.off("listening", onListening);
      void closeServer(server, true).then(() => {
        if (errorCode(error) === "EADDRINUSE") resolvePromise(null);
        else reject(error);
      }, reject);
    };

    server.once("listening", onListening);
    server.once("error", onError);
    try {
      server.listen(address);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Serialize first pipeline construction within one Linux network namespace. */
export async function withEmbeddingCacheLoadLock<T>(
  cacheDir: string | null,
  modelId: string,
  work: () => Promise<T>
): Promise<T> {
  // ponytail: per-network-namespace Linux lock; revisit only if one cache is mounted across
  // containers/platforms.
  if (process.platform !== "linux") {
    throw new Error("local embedding cache initialization lock requires Linux");
  }
  if (!cacheDir) throw new Error("local embedding filesystem cache is unavailable");

  await mkdir(cacheDir, { recursive: true });
  const canonicalCacheDir = await realpath(cacheDir);
  const digest = createHash("sha256")
    .update(canonicalCacheDir)
    .update("\0")
    .update(modelId)
    .digest("hex");
  // Linux abstract Unix-socket names are capped at 107 bytes; this is 76 and reveals no identity.
  const address = `${LOCK_PREFIX}${digest}`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  let owner: Server | null = null;
  while (!owner) {
    owner = await tryListen(address);
    if (owner) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("timed out waiting for local embedding cache initialization lock");
    }
    await delay(Math.min(LOCK_POLL_MS, remaining));
  }

  let value!: T;
  let workError: unknown;
  let workFailed = false;
  let cleanupError: unknown;
  try {
    value = await work();
  } catch (error) {
    workFailed = true;
    workError = error;
  } finally {
    try {
      await closeServer(owner);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (workFailed && cleanupError !== undefined) {
    throw new AggregateError(
      [workError, cleanupError],
      "embedding cache initialization and lock cleanup both failed"
    );
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (workFailed) throw workError;
  return value;
}
