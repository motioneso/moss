import { createServer } from "node:http";
import { chmod, chown, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseHostRequest } from "../../apps/api/src/computer/host-contract.js";
import { readHostJson } from "../../apps/api/src/computer/host-http.js";
import type { ComputerHostOperations } from "./operations.js";
import type { HostStateStore } from "./state.js";

/** No TCP binding. The directory/socket permissions are the trusted API peer boundary. */
export async function serveComputerHost(store: HostStateStore, operations: ComputerHostOperations) {
  const socketPath = join(store.config.controlDir, "host.sock");
  await store.assertRoots();
  try {
    await lstat(socketPath);
    throw new Error("Computer control socket already exists");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const handlers = new Set<Promise<void>>();
  const server = createServer(
    { maxHeaderSize: 4096, requestTimeout: 2000, headersTimeout: 2000 },
    (request, response) => {
      const task = (async () => {
        response.setHeader("content-type", "application/json");
        response.setHeader("connection", "close");
        if (
          request.method !== "POST" ||
          request.url !== "/operation" ||
          request.headers["content-type"] !== "application/json" ||
          request.headers["content-encoding"] !== undefined
        ) {
          response.writeHead(400).end('{"error":"invalid-request"}');
          return;
        }
        const timer = setTimeout(() => request.destroy(), 2000);
        let parsed;
        try {
          parsed = parseHostRequest(await readHostJson(request, 1024));
        } catch {
          response.writeHead(400).end('{"error":"invalid-request"}');
          request.destroy();
          return;
        } finally {
          clearTimeout(timer);
        }
        const result = await operations.request(parsed);
        response.writeHead(200).end(JSON.stringify(result));
      })().catch(() => {
        if (!response.headersSent) response.writeHead(503).end('{"error":"runtime-unavailable"}');
        else response.destroy();
      });
      handlers.add(task);
      void task.finally(() => handlers.delete(task));
    }
  );
  server.maxConnections = 8;
  server.maxHeadersCount = 16;
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    const directory = await lstat(store.config.controlDir);
    await chown(socketPath, process.getuid!(), directory.gid);
    await chmod(socketPath, 0o660);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const identity = await lstat(socketPath);
  return {
    socketPath,
    async close() {
      // Stop accepting immediately; await all host operations before the caller releases the lock.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.allSettled([...handlers]);
      await closed;
      // Node normally unlinks its Unix socket on close. Never remove a replacement socket.
      const remaining = await lstat(socketPath).catch(() => null);
      if (remaining && remaining.dev === identity.dev && remaining.ino === identity.ino)
        await unlink(socketPath);
    }
  };
}
