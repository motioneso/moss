/** The old Scratchpad routes and real repositories, run on the disposable gate database. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { registerScratchpadRoutes } from "../../../packages/scratchpad/src/routes.js";

type Step = { method: "GET" | "PATCH" | "POST" | "PUT"; url: string; body?: unknown };

export async function routesOracle(actor: string, steps: readonly Step[]) {
  assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
  const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
  const server = Fastify();
  setMossErrorHandler(server);
  registerScratchpadRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "scratchpad-parity" }),
    dataContext: new DataContextRunner(db)
  });
  try {
    const responses = [];
    for (const { method, url, body } of steps) {
      const result = await server.inject({
        method,
        url,
        ...(body === undefined
          ? {}
          : { payload: JSON.stringify(body), headers: { "content-type": "application/json" } })
      });
      responses.push({ status: result.statusCode, body: result.json() as unknown });
    }
    return { responses };
  } finally {
    await server.close();
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith("routes-oracle.ts")) {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const { actor, steps }: { actor: string; steps: Step[] } = JSON.parse(input);
  console.log(JSON.stringify(await routesOracle(actor, steps)));
}
