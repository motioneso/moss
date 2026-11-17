/** Runs the old Meals log tools and estimate job on rows in the disposable database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getMossDatabaseUrls } from "@moss/db";
import { runLogEstimate } from "../../../external-modules/meals/src/log/job.js";
import {
  logAdd,
  logCorrect,
  logDelete,
  logList,
  logReestimate,
  logSummarize
} from "../../../external-modules/meals/src/log/tools.js";
import { sqlLogStore } from "../../../external-modules/meals/src/store/log.js";
import { sqlStore } from "../../../external-modules/meals/src/store/sql.js";
import { stripEnvelope } from "../../../external-modules/meals/src/tools/validate.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
let raw = "";
for await (const chunk of process.stdin) raw += String(chunk);
const { actor, role, tool, parameters, answer } = JSON.parse(raw) as {
  actor: string;
  role: string;
  tool: string;
  parameters: Record<string, unknown>;
  /** The model's reply as text, or null when the model call should fail. */
  answer?: string | null;
};
const tools: Record<string, Function> = {
  "meals.log.list": logList,
  "meals.log.summarize": logSummarize,
  "meals.log.add": logAdd,
  "meals.log.correct": logCorrect,
  "meals.log.reestimate": logReestimate,
  "meals.log.delete": logDelete
};
const client = new pg.Client({ connectionString: getMossDatabaseUrls().bootstrap });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`SET LOCAL ROLE ${role}`);
  await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actor]);
  const db = {
    query: async (text: string, params?: readonly unknown[]) => {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows };
    }
  };
  const queued: unknown[] = [];
  let reply: unknown;
  try {
    if (tool === "job") {
      const ai = {
        generateStructured: async () =>
          answer == null
            ? { ok: false as const, error: "provider_error" as const }
            : { ok: true as const, object: JSON.parse(answer) }
      };
      const data = await runLogEstimate({ store: sqlLogStore(db as never), ai } as never, parameters);
      reply = { data };
    } else {
      const run = tools[tool];
      assert.ok(run, "Unknown legacy log tool");
      const kitchens = sqlStore(db as never);
      const deps = {
        store: sqlLogStore(db as never),
        kitchen: () => kitchens.readKitchen(),
        jobs: {
          enqueue: async (job: Record<string, unknown>) => {
            queued.push({ queue: job.queue, params: job.params });
            return { status: "enqueued" };
          }
        },
        newId: randomUUID,
        now: () => new Date(),
        localTimezone: "America/Los_Angeles"
      };
      reply = { data: await run(deps, stripEnvelope(parameters)) };
    }
  } catch (error) {
    const failure = error as { message?: string; code?: unknown };
    if (typeof failure.code !== "string") throw error;
    reply = { data: { error: failure.message, code: failure.code } };
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ reply, queued }));
} finally {
  await client.end();
}
