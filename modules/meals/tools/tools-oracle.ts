/** Runs the old Meals kitchen and household handlers on rows in the disposable database. */
import assert from "node:assert/strict";
import pg from "pg";
import { getMossDatabaseUrls } from "@moss/db";
import { HANDLERS } from "../../../external-modules/meals/src/worker/registry.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
let raw = "";
for await (const chunk of process.stdin) raw += String(chunk);
const { actor, role, tool, parameters } = JSON.parse(raw) as {
  actor: string;
  role: string;
  tool: string;
  parameters: Record<string, unknown>;
};
const handler = HANDLERS[tool.replace(/^meals\./, "")];
assert.ok(handler, "Unknown legacy tool");
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
  let reply: unknown;
  try {
    // // The plan tools queue background work; the stand-in accepts every job so the reply can be compared.
    const jobs = { enqueue: async () => ({ status: "queued" }) };
    const data = await handler({ input: parameters, db, jobs } as never);
    reply = { data };
  } catch (error) {
    const failure = error as { message?: string; code?: unknown };
    // The plan tools signal a refused input with an error that has no code; the platform reports it as invalid input.
    const code =
      failure.code ??
      (error instanceof Error && error.constructor.name === "PlanInputError"
        ? "invalid_input"
        : undefined);
    if (typeof code !== "string") throw error;
    reply = { data: { error: failure.message, code } };
  }
  await client.query("COMMIT");
  console.log(JSON.stringify(reply));
} finally {
  await client.end();
}
