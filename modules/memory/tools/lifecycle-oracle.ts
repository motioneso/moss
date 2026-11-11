/** Runs the old fact routes (pin, confirm, correct, status, mark-stale, supersede, delete)
 *  against a real database for fixed scenarios and writes or checks lifecycle-cases.json.
 *  The Rust database tests replay the same scenarios through the real guest and compare.
 *    lifecycle-oracle.ts write   regenerate the file from the old code
 *    lifecycle-oracle.ts check   fail when the old code no longer matches the file
 *  Run only through scripts/run-gate.sh. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import { sql } from "kysely";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { MemoryGraphRepository } from "../../../packages/memory/src/graph-repository.js";
import { registerMemoryGraphRoutes } from "../../../packages/memory/src/graph-routes.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use scripts/run-gate.sh");
process.env.JARVIS_EMBED_PROVIDER = "stub";

const file = new URL("./lifecycle-cases.json", import.meta.url);
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";

type Request = { path: string; method: string; target: "first" | "unknown"; body?: unknown };
type Case = { name: string; seed: string; request: Request };

const post = (path: string, body: unknown = {}): Request => ({
  path,
  method: "POST",
  target: "first",
  body
});
const missing = (request: Request): Request => ({ ...request, target: "unknown" });
const remove: Request = { path: "", method: "DELETE", target: "first" };

const CASES: Case[] = [
  { name: "pin: unknown fact", seed: "none", request: missing(post("pin", { pinned: true })) },
  { name: "pin: ok", seed: "plain", request: post("pin", { pinned: true }) },
  { name: "pin: missing body field", seed: "plain", request: post("pin", {}) },
  { name: "confirm: unknown fact", seed: "none", request: missing(post("confirm")) },
  { name: "confirm: ok", seed: "plain", request: post("confirm") },
  { name: "confirm: extra body field", seed: "plain", request: post("confirm", { x: 1 }) },
  { name: "confirm: recording fact", seed: "recording", request: post("confirm") },
  { name: "confirm: conflict of two", seed: "conflict2", request: post("confirm") },
  { name: "confirm: conflict of three", seed: "conflict3", request: post("confirm") },
  {
    name: "correct: unknown fact",
    seed: "none",
    request: missing(post("correct", { replacementText: "x" }))
  },
  { name: "correct: ok", seed: "plain", request: post("correct", { replacementText: "oat milk" }) },
  { name: "correct: missing text", seed: "plain", request: post("correct", {}) },
  {
    name: "correct: recording fact",
    seed: "recording",
    request: post("correct", { replacementText: "x" })
  },
  {
    name: "correct: conflict of two",
    seed: "conflict2",
    request: post("correct", { replacementText: "settled" })
  },
  {
    name: "status: unknown fact",
    seed: "none",
    request: missing(post("status", { status: "stale" }))
  },
  {
    name: "status: stale",
    seed: "plain",
    request: post("status", { status: "stale", reason: "old" })
  },
  { name: "status: expired", seed: "plain", request: post("status", { status: "expired" }) },
  { name: "status: rejected", seed: "plain", request: post("status", { status: "rejected" }) },
  { name: "status: bad value", seed: "plain", request: post("status", { status: "gone" }) },
  { name: "status: missing value", seed: "plain", request: post("status", {}) },
  {
    name: "status: conflict member",
    seed: "conflict2",
    request: post("status", { status: "stale" })
  },
  {
    name: "status: reactivate superseded",
    seed: "superseded",
    request: post("status", { status: "active" })
  },
  {
    name: "status: reject superseded",
    seed: "superseded",
    request: post("status", { status: "rejected" })
  },
  {
    name: "status: recording fact",
    seed: "recording",
    request: post("status", { status: "stale" })
  },
  { name: "mark-stale: unknown fact", seed: "none", request: missing(post("mark-stale")) },
  { name: "mark-stale: ok", seed: "plain", request: post("mark-stale") },
  { name: "mark-stale: conflict member", seed: "conflict2", request: post("mark-stale") },
  { name: "supersede: unknown fact", seed: "none", request: missing(post("supersede")) },
  { name: "supersede: ok", seed: "plain", request: post("supersede") },
  {
    name: "supersede: with date",
    seed: "plain",
    request: post("supersede", { validTo: "2026-12-01T00:00:00.000Z" })
  },
  { name: "supersede: recording fact", seed: "recording", request: post("supersede") },
  { name: "delete: unknown fact", seed: "none", request: missing(remove) },
  { name: "delete: ok", seed: "plain", request: remove },
  { name: "delete: recording fact", seed: "recording", request: remove },
  { name: "delete: one of two conflicting", seed: "conflict2", request: remove },
  { name: "delete: one of three conflicting", seed: "conflict3", request: remove },
  { name: "delete: overruled fact after confirm", seed: "confirmed3", request: remove }
];

const urls = getMossDatabaseUrls();
const boot = createDatabase({ connectionString: urls.bootstrap, maxConnections: 1 });
const appDb = createDatabase({ connectionString: urls.app, maxConnections: 2 });
const runner = new DataContextRunner(appDb as never);
const repo = new MemoryGraphRepository();

const server = Fastify();
registerMemoryGraphRoutes(server, {
  dataContext: runner,
  resolveAccessContext: async (request: FastifyRequest) => {
    const user = request.headers.authorization?.replace("Bearer ", "");
    if (!user) throw new Error("Unauthorized");
    return { actorUserId: user, requestId: "lifecycle-oracle" };
  }
});

async function seed(kind: string, user: string): Promise<{ ids: string[]; group: string | null }> {
  const count =
    { none: 0, plain: 1, recording: 1, conflict2: 2, superseded: 2, conflict3: 3, confirmed3: 3 }[
      kind
    ] ?? 0;
  const as = { actorUserId: user, requestId: "lifecycle-oracle-seed" };
  return runner.withDataContext(as as never, async (db) => {
    const self = await repo.ensureSelfEntity(db, user);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const fact = await repo.createFact(db, user, {
        subjectEntityId: self.id,
        predicate: "prefers",
        objectText: `case fact ${i + 1}`,
        confidence: 0.8,
        provenance: "volunteered",
        source: { sourceKind: "manual", sourceRef: `manual:${i + 1}`, excerpt: `fact ${i + 1}` }
      });
      ids.push(fact.id);
    }
    let group: string | null = null;
    if (kind.startsWith("conflict") || kind === "confirmed3") {
      const made = await sql<{ id: string }>`
        INSERT INTO app.memory_conflict_groups (owner_user_id) VALUES (${user}::uuid) RETURNING id`.execute(
        db.db
      );
      group = made.rows[0]?.id ?? null;
      await sql`
        UPDATE app.memory_facts SET status = 'conflicting', conflict_group_id = ${group}::uuid
        WHERE owner_user_id = ${user}::uuid
          AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`))})`.execute(db.db);
      for (const id of ids) await repo.setSearchDocumentStatus(db, user, "fact", id, "inactive");
    }
    if (kind === "confirmed3") await repo.confirmFact(db, user, ids[0]!);
    if (kind === "superseded") {
      await sql`
        UPDATE app.memory_facts SET status = 'superseded', superseded_by_fact_id = ${ids[1]}::uuid
        WHERE owner_user_id = ${user}::uuid AND id = ${ids[0]}::uuid`.execute(db.db);
    }
    return { ids, group };
  });
}

async function addRecording(user: string, factId: string) {
  await sql`
    INSERT INTO app.memory_recording_fact_versions (owner_user_id, fact_id, lineage_id, side)
    VALUES (${user}::uuid, ${factId}::uuid, ${randomUUID()}::uuid, 'personal')`.execute(boot);
}

function shape(status: number, text: string): unknown {
  if (status === 204) return null;
  const body = JSON.parse(text) as Record<string, unknown>;
  const fact = body.fact as Record<string, unknown> | undefined;
  if (!fact) return body;
  return {
    status: fact.status,
    provenance: fact.provenance,
    confidence: fact.confidence,
    pinned: fact.pinned,
    objectText: fact.objectText,
    confidenceTier: fact.confidenceTier,
    hasGroup: fact.conflictGroupId != null,
    sourceCount: (fact.sources as unknown[]).length,
    keys: Object.keys(fact).sort()
  };
}

async function after(user: string, ids: string[], group: string | null) {
  const as = { actorUserId: user, requestId: "lifecycle-oracle-read" };
  return runner.withDataContext(as as never, async (db) => {
    const facts = [];
    for (const id of ids) {
      const f = await sql<{
        status: string;
        g: string | null;
        valid_to: Date | null;
        stale_at: Date | null;
        pinned: boolean;
        by: string | null;
      }>`
        SELECT status, conflict_group_id::text AS g, valid_to, stale_at, pinned, superseded_by_fact_id::text AS by
        FROM app.memory_facts WHERE owner_user_id = ${user}::uuid AND id = ${id}::uuid`.execute(
        db.db
      );
      const d = await sql<{ status: string }>`
        SELECT status FROM app.memory_search_documents
        WHERE owner_user_id = ${user}::uuid AND target_kind = 'fact' AND target_id = ${id}::uuid`.execute(
        db.db
      );
      const row = f.rows[0];
      facts.push(
        row
          ? {
              status: row.status,
              hasGroup: row.g != null,
              hasValidTo: row.valid_to != null,
              hasStaleAt: row.stale_at != null,
              pinned: row.pinned,
              supersededBy: row.by == null ? null : ids.indexOf(row.by),
              doc: d.rows[0]?.status ?? null
            }
          : null
      );
    }
    const g = group
      ? ((
          await sql<{ status: string }>`
          SELECT status FROM app.memory_conflict_groups
          WHERE owner_user_id = ${user}::uuid AND id = ${group}::uuid`.execute(db.db)
        ).rows[0]?.status ?? null)
      : null;
    const total = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.memory_facts WHERE owner_user_id = ${user}::uuid`.execute(
      db.db
    );
    return { facts, group: g, total: Number(total.rows[0]?.n ?? 0) };
  });
}

async function run(c: Case) {
  const user = randomUUID();
  await sql`INSERT INTO app.users (id, email, name, is_instance_admin)
    VALUES (${user}::uuid, ${`${user}@example.test`}, 'Oracle', false)`.execute(boot);
  const planted = await seed(c.seed, user);
  if (c.seed === "recording") await addRecording(user, planted.ids[0]!);
  const id = c.request.target === "first" ? planted.ids[0]! : UNKNOWN;
  const url = `/api/memory/graph/facts/${id}${c.request.path ? `/${c.request.path}` : ""}`;
  const res = await server.inject({
    method: c.request.method as "POST" | "DELETE",
    url,
    headers: { authorization: `Bearer ${user}` },
    ...(c.request.body === undefined ? {} : { payload: c.request.body as object })
  });
  return {
    ...c,
    status: res.statusCode,
    body: shape(res.statusCode, res.body),
    after: await after(user, planted.ids, planted.group)
  };
}

try {
  await server.ready();
  const results = [];
  for (const c of CASES) results.push(await run(c));
  const text = `${JSON.stringify(results, null, 2)}\n`;
  if (process.argv[2] === "write") {
    writeFileSync(file, text);
    console.log(`wrote ${results.length} cases`);
  } else {
    assert.deepEqual(JSON.parse(text), JSON.parse(readFileSync(file, "utf8")));
    console.log(`lifecycle-cases.json matches the old code (${results.length} cases)`);
  }
} finally {
  await server.close();
  await appDb.destroy();
  await boot.destroy();
}
