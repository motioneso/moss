// Run the actual legacy worker against real isolated PostgreSQL. Only queue
// delivery and the optional provider are fixtures; no installed UI is claimed.
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import type pg from "pg";
import type { DataContextRunner } from "@moss/db";
import type { PersonContextSignal } from "@moss/module-sdk";
import { registerPersonIndexWorker } from "../../../packages/people/src/workers.js";
import type { PersonIndexPayload } from "../../../packages/people/src/jobs.js";

const tables = [
  "app.person_context_people",
  "app.person_context_identities",
  "app.person_context_links",
  "app.person_context_link_sources",
  "app.person_context_match_candidates",
  "app.person_context_events",
  "app.person_context_indexing_state"
] as const;

export async function jobsOracle(
  bootstrap: pg.Client,
  runner: DataContextRunner,
  actor: string
): Promise<unknown> {
  await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'People jobs oracle')", [
    actor,
    `people-jobs-${actor}@example.test`
  ]);
  let delivered: ((jobs: { id: string; data: PersonIndexPayload }[]) => Promise<void>) | undefined;
  const queued: unknown[] = [];
  const boss = new PgBoss({ connectionString: "postgres://unused@example.invalid/fixture" });
  boss.work = async (...args: unknown[]) => {
    const handler = args.at(-1);
    if (typeof handler !== "function") throw new Error("Legacy worker callback missing");
    delivered = handler as typeof delivered;
    return "people-job-oracle";
  };
  boss.send = async (...args: unknown[]) => {
    queued.push({ queue: args[0], payload: args[1] });
    return randomUUID();
  };
  const signals: PersonContextSignal[] = [
    {
      sourceVersion: "signal-version-one",
      sourceRef: "email-source/one",
      sourceRefHash: "signal-one",
      identityKind: "email_address",
      normalizedValue: "  ALICE@example.test  ",
      displayValue: "Worker Alice",
      linkKind: "sender",
      sourceLabel: "First label",
      summary: "Synthetic private source context",
      occurredAt: new Date("2020-01-01Z"),
      confidence: 0.6,
      provenance: "source"
    },
    {
      sourceVersion: "signal-version-two",
      sourceRef: "email-source/two",
      sourceRefHash: "signal-two",
      identityKind: "email_address",
      normalizedValue: "  ALICE@example.test  ",
      displayValue: "Ignored later spelling",
      linkKind: "recipient",
      confidence: 0.8,
      provenance: "inferred"
    },
    {
      sourceVersion: "signal-version-three",
      sourceRef: "email-source/three",
      sourceRefHash: "signal-three",
      identityKind: "alias",
      normalizedValue: "Bobby",
      displayValue: "Worker Bob",
      linkKind: "related",
      confidence: 0.5,
      provenance: "imported"
    }
  ];
  const inputs = [
    { source: "manual", sourceRefHash: "missing-provider", reason: "manual_refresh" },
    {
      source: "email",
      sourceRefHash: "sha256:opaque/source/🪴",
      sourceVersion: "opaque:v1/🪴",
      reason: "manual_refresh"
    },
    {
      source: "email",
      sourceRefHash: "sha256:opaque/source/🪴",
      sourceVersion: "opaque:v2/🪴",
      reason: "source_changed"
    },
    { source: "email", sourceRefHash: "empty-source", reason: "manual_refresh" }
  ] as const;
  const providerInputs: unknown[] = [];
  await registerPersonIndexWorker(boss, runner, {
    providers: [
      {
        sourceKind: "email",
        collectPersonSignals: async (input) => {
          providerInputs.push(input);
          return { signals: input.sourceRefHash === "empty-source" ? [] : signals };
        }
      }
    ]
  });
  if (!delivered) throw new Error("Legacy worker not registered");
  const startedAt = new Date().toISOString();
  const cases: unknown[] = [];
  for (const input of inputs) {
    const commandId = randomUUID();
    queued.length = 0;
    providerInputs.length = 0;
    const payload: PersonIndexPayload = {
      ...input,
      actorUserId: actor,
      idempotencyKey: `person-index:${actor}:${input.sourceRefHash}`
    };
    await delivered([{ id: commandId, data: payload }]);
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      const result = await bootstrap.query<{ row: unknown }>(
        `SELECT to_jsonb(p) AS row FROM ${table} p WHERE owner_user_id=$1`,
        [actor]
      );
      rows[table] = result.rows.map(({ row }) => row);
    }
    cases.push({
      command: { commandId, ...input },
      rows,
      queued: [...queued],
      providerInputs: [...providerInputs]
    });
  }
  // Keep the actor, clear only its disposable oracle writes, then replay in Rust.
  for (const table of [...tables].reverse()) {
    await bootstrap.query(`DELETE FROM ${table} WHERE owner_user_id=$1`, [actor]);
  }
  return { actor, startedAt, signals, cases };
}
