// Phase 0b parity harness only. Boots the TypeScript API server and the Tasks job worker the way
// tests/integration/tasks.test.ts does, against the database the environment names, so the
// harness can send it the same requests it sends the Rust server.

import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { registerTasksJobWorkers } from "@moss/tasks";

import { createApiServer } from "../../apps/api/src/server.js";

async function main(): Promise<void> {
  if (process.env.JARVIS_GATE_RUN !== "1" && process.env.MOSS_GATE_RUN !== "1") {
    console.error("refusing: not inside a gate run");
    process.exit(3);
  }
  const port = Number(process.env.TASKS_SPIKE_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    console.error("TASKS_SPIKE_PORT must be a port number");
    process.exit(3);
  }

  const urls = getMossDatabaseUrls();
  const appDb = createDatabase({ connectionString: urls.app, maxConnections: 4 });
  const workerDb = createDatabase({ connectionString: urls.worker, maxConnections: 2 });
  const appBoss = createPgBossClient(urls.app);
  const workerBoss = createPgBossClient(urls.worker);
  await appBoss.start();
  await workerBoss.start();
  await registerTasksJobWorkers(workerBoss, new DataContextRunner(workerDb), {
    workOptions: { pollingIntervalSeconds: 0.5 }
  });

  const server = createApiServer({ appDb, boss: appBoss, logger: false });
  await server.listen({ host: "127.0.0.1", port });
  console.log(`TS READY ${port}`);

  const stop = async (): Promise<void> => {
    await Promise.allSettled([
      server.close(),
      appBoss.stop({ graceful: false }),
      workerBoss.stop({ graceful: false }),
      appDb.destroy(),
      workerDb.destroy()
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
