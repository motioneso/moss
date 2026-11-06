// Child process for the two-process log sink check. Run as `tsx log-sink-child.ts api|worker
// <ownerUserId> <canary>`. It emits one real warning through the same logger wiring the
// production process uses, then shuts down so the sink flushes.
import { createDatabase, getMossDatabaseUrls } from "@moss/db";
import { withLogOwner } from "@moss/settings";

import { createApiServer } from "../../../apps/api/src/server.js";
import { createWorkerLogging } from "../../../apps/worker/src/worker.js";

const [kind, owner, canary] = process.argv.slice(2) as [string, string, string];

if (kind === "api") {
  const server = createApiServer({ logger: { level: "info" } });
  const log = withLogOwner(server.log.child({ module: "connectors" }), owner);
  log.warn(
    { connectionKind: "google", eventCode: "auth-failed" },
    `api warning Authorization: Bearer ${canary}`
  );
  await server.close();
} else {
  const workerDb = createDatabase({
    connectionString: getMossDatabaseUrls().worker,
    maxConnections: 1
  });
  const { logger, sink } = createWorkerLogging(workerDb);
  withLogOwner(logger.child({ module: "email" }), owner).warn(
    { connectionKind: "imap", eventCode: "sync-failed" },
    `worker warning postgres://u:${canary}@h/db`
  );
  await sink.close();
  await workerDb.destroy();
}
