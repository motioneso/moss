// Real pg-boss sends under the legacy module's standard queue policy. Gate only.
import { PgBoss } from "pg-boss";
import type pg from "pg";

export async function refreshQueue(connectionString: string, db: pg.Client) {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const boss = new PgBoss({
    connectionString,
    schema: "people_refresh_oracle",
    supervise: false,
    schedule: false
  });
  try {
    await boss.start();
    await boss.createQueue("person-index");
    const queue = await boss.getQueue("person-index");
    if (queue?.policy !== "standard") throw new Error("Legacy People queue must be standard");
  } catch (error) {
    await boss.stop();
    throw error;
  }
  return {
    boss,
    async snapshot() {
      const result = await db.query<{ data: Record<string, unknown>; delay: number }>(
        `SELECT data, extract(epoch FROM start_after-created_on)::float8 AS delay
         FROM people_refresh_oracle.job WHERE name='person-index' ORDER BY created_on,id`
      );
      return result.rows.map(({ data, delay }) => {
        if (Math.abs(delay - 900) > 1)
          throw new Error("Legacy indexing delay must be fifteen minutes");
        // The legacy string key is private command metadata in Rust. Compare its
        // source fields and authenticated owner, not the different queue envelopes.
        const { idempotencyKey: _key, ...command } = data;
        return command;
      });
    }
  };
}

type Run = (method: "POST", path: string, body: unknown, actorIndex?: number) => Promise<void>;
export async function refreshCases(run: Run) {
  const ref = {
    source: "email",
    sourceRefHash: "opaque/hash/🪴",
    sourceVersion: "v1",
    reason: "manual_refresh"
  };
  const path = "/people/index/refresh";
  for (const body of [
    {},
    [],
    null,
    { sourceRefs: {} },
    { sourceRefs: null },
    { sourceRefs: "email" },
    { sourceRefs: [null] },
    { sourceRefs: [{}] },
    { sourceRefs: [ref, {}] },
    { sourceRefs: [{ source: "email", sourceRefHash: "hash" }] },
    { sourceRefs: [{ ...ref, source: {} }] },
    { sourceRefs: Array.from({ length: 51 }, () => ref) },
    { sourceRefs: [] },
    { sourceRefs: [ref] },
    { sourceRefs: [ref] },
    { sourceRefs: [{ ...ref, sourceVersion: "v2" }, ref] },
    {
      sourceRefs: [{ source: null, sourceRefHash: 42, sourceVersion: false, reason: ["refresh"] }]
    },
    { sourceRefs: [{ ...ref, actorUserId: "must-not-select-an-account" }], actorUserId: "ignored" },
    { sourceRefs: Array.from({ length: 50 }, () => ref) }
  ])
    await run("POST", path, body);
  for (const actor of [1, 2]) await run("POST", path, { sourceRefs: [ref] }, actor);
}
