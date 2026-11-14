/** The old Goals routes on the disposable gate database. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { registerGoalsRoutes } from "../../../packages/goals/src/routes.js";

type Step = { method: "GET" | "POST" | "PATCH"; url: string; body?: unknown };

export async function routesOracle(
  actor: string,
  steps: readonly Step[],
  vars: Readonly<Record<string, string>> = {}
) {
  assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
  const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
  const server = Fastify();
  setMossErrorHandler(server);
  registerGoalsRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "goals-parity" }),
    dataContext: new DataContextRunner(db),
    boss: { send: async () => null } as never
  });
  try {
    const responses = [];
    const fill = (text: string) =>
      text.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? _m);
    for (const { method, url: template, body } of steps) {
      const result = await server.inject({
        method,
        url: fill(template),
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
  const { actor, steps, vars }: { actor: string; steps: Step[]; vars?: Record<string, string> } =
    JSON.parse(input);
  console.log(JSON.stringify(await routesOracle(actor, steps, vars)));
}
