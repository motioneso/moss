import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Job } from "@moss/jobs";
import type { Kysely } from "kysely";
import { VaultContextRunner, readVaultFile } from "@moss/vault";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import pg from "pg";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import type { ExportBuildJobPayload } from "../../packages/settings/src/data-export-jobs.js";

const { Client } = pg;

type PersonalRecordIds = Record<
  | "entity"
  | "fact"
  | "episode"
  | "alias"
  | "candidate"
  | "conflictGroup"
  | "goal"
  | "goalEvidence"
  | "taskList"
  | "task"
  | "taskActivity"
  | "notification"
  | "moduleKv"
  | "feedbackSignal"
  | "auditLog",
  string
>;

const personalId = (n: number) => `99999999-0000-4000-9000-${String(n).padStart(12, "0")}`;

function personalRecordIds(base: number): PersonalRecordIds {
  const keys = [
    "entity",
    "fact",
    "episode",
    "alias",
    "candidate",
    "conflictGroup",
    "goal",
    "goalEvidence",
    "taskList",
    "task",
    "taskActivity",
    "notification",
    "moduleKv",
    "feedbackSignal",
    "auditLog"
  ] as const;
  return Object.fromEntries(keys.map((key, i) => [key, personalId(base + i)])) as PersonalRecordIds;
}

// Seeds one row in each record type added by issue 3219. Every text value carries
// EXPORT-<who>- so a leak shows up as a plain substring match.
async function seedPersonalRecords(
  client: pg.Client,
  owner: string,
  who: "A" | "B",
  r: PersonalRecordIds
): Promise<void> {
  const tag = `EXPORT-${who}-`;
  await client.query(
    `INSERT INTO app.memory_entities (id, owner_user_id, kind, name) VALUES ($1, $2, 'topic', $3)`,
    [r.entity, owner, `${tag}entity`]
  );
  await client.query(
    `INSERT INTO app.memory_facts (id, owner_user_id, subject_entity_id, predicate, object_text)
     VALUES ($1, $2, $3, 'related_to', $4)`,
    [r.fact, owner, r.entity, `${tag}fact`]
  );
  await client.query(
    `INSERT INTO app.memory_episodes (id, owner_user_id, source_kind, source_ref)
     VALUES ($1, $2, 'manual', $3)`,
    [r.episode, owner, `${tag}episode`]
  );
  await client.query(
    `INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id) VALUES ($1, $2, $3)`,
    [owner, r.fact, r.episode]
  );
  await client.query(
    `INSERT INTO app.memory_aliases (id, owner_user_id, entity_id, alias, normalized_alias)
     VALUES ($1, $2, $3, $4, $4)`,
    [r.alias, owner, r.entity, `${tag}alias`]
  );
  await client.query(
    `INSERT INTO app.memory_candidates
       (id, owner_user_id, episode_id, kind, action, payload_json, candidate_signature,
        confidence, importance, provenance)
     VALUES ($1, $2, $3, 'fact', 'create', $4::jsonb, $5, 0.5, 0.5, 'inferred')`,
    [r.candidate, owner, r.episode, JSON.stringify({ marker: `${tag}candidate` }), `${tag}sig`]
  );
  await client.query(`INSERT INTO app.memory_conflict_groups (owner_user_id, id) VALUES ($1, $2)`, [
    owner,
    r.conflictGroup
  ]);
  await client.query(
    `INSERT INTO app.moss_goals (id, owner_user_id, title, desired_outcome)
     VALUES ($1, $2, $3, 'outcome')`,
    [r.goal, owner, `${tag}goal`]
  );
  await client.query(
    `INSERT INTO app.moss_goal_evidence
       (id, owner_user_id, goal_id, evidence_kind, source_kind, source_label, summary)
     VALUES ($1, $2, $3, 'context', 'manual', 'label', $4)`,
    [r.goalEvidence, owner, r.goal, `${tag}goal-evidence`]
  );
  await client.query(`INSERT INTO app.task_lists (id, owner_user_id, name) VALUES ($1, $2, $3)`, [
    r.taskList,
    owner,
    `${tag}list`
  ]);
  await client.query(
    `INSERT INTO app.tasks (id, owner_user_id, title, list_id) VALUES ($1, $2, $3, $4)`,
    [r.task, owner, `${tag}task`, r.taskList]
  );
  await client.query(
    `INSERT INTO app.task_activity (id, task_id, actor_user_id, activity_type, body)
     VALUES ($1, $2, $3, 'comment', $4)`,
    [r.taskActivity, r.task, owner, `${tag}activity`]
  );
  await client.query(
    `INSERT INTO app.notifications (id, actor_user_id, recipient_user_id, title)
     VALUES ($1, $2, $2, $3)`,
    [r.notification, owner, `${tag}notification`]
  );
  await client.query(
    `INSERT INTO app.notification_reads (notification_id, user_id) VALUES ($1, $2)`,
    [r.notification, owner]
  );
  await client.query(
    `INSERT INTO app.module_kv (id, module_id, namespace, scope, owner_user_id, key, value)
     VALUES ($1, 'export-test', 'ns', 'user', $2, $3, $4::jsonb)`,
    [r.moduleKv, owner, `${tag}key`, JSON.stringify({ marker: `${tag}kv` })]
  );
  await client.query(
    `INSERT INTO app.usefulness_feedback_signals
       (id, owner_user_id, target_kind, target_ref, surface, kind)
     VALUES ($1, $2, 'chat_message', $3, 'chat', 'not_useful')`,
    [r.feedbackSignal, owner, `${tag}target`]
  );
  await client.query(
    `INSERT INTO app.usefulness_feedback_targets (owner_user_id, target_kind, target_ref, surface)
     VALUES ($1, 'chat_message', $2, 'chat')`,
    [owner, `${tag}target`]
  );
  await client.query(
    `INSERT INTO app.moss_action_audit_log
       (id, owner_user_id, tool_module_id, tool_name, action_kind, approval_mode, outcome)
     VALUES ($1, $2, 'export-test', $3, 'write', 'auto', 'success')`,
    [r.auditLog, owner, `${tag}tool`]
  );
}

async function removePersonalRecords(client: pg.Client, all: PersonalRecordIds[]): Promise<void> {
  const of = (key: keyof PersonalRecordIds) => [all.map((r) => r[key])];
  await client.query(
    "DELETE FROM app.moss_action_audit_log WHERE id = ANY($1::uuid[])",
    of("auditLog")
  );
  await client.query(
    "DELETE FROM app.usefulness_feedback_signals WHERE id = ANY($1::uuid[])",
    of("feedbackSignal")
  );
  await client.query(
    "DELETE FROM app.usefulness_feedback_targets WHERE target_ref LIKE 'EXPORT-%'"
  );
  await client.query("DELETE FROM app.module_kv WHERE id = ANY($1::uuid[])", of("moduleKv"));
  await client.query(
    "DELETE FROM app.notifications WHERE id = ANY($1::uuid[])",
    of("notification")
  );
  await client.query("DELETE FROM app.tasks WHERE id = ANY($1::uuid[])", of("task"));
  await client.query("DELETE FROM app.task_lists WHERE id = ANY($1::uuid[])", of("taskList"));
  await client.query("DELETE FROM app.moss_goals WHERE id = ANY($1::uuid[])", of("goal"));
  await client.query(
    "DELETE FROM app.memory_conflict_groups WHERE id = ANY($1::uuid[])",
    of("conflictGroup")
  );
  await client.query("DELETE FROM app.memory_episodes WHERE id = ANY($1::uuid[])", of("episode"));
  await client.query("DELETE FROM app.memory_entities WHERE id = ANY($1::uuid[])", of("entity"));
}

describe("Data export personal records (#3219)", () => {
  const personalA = personalRecordIds(1);
  const personalB = personalRecordIds(101);
  const sportsFollowA = "99999999-0000-4000-8000-000000000301";
  const sportsFollowB = "99999999-0000-4000-8000-000000000302";
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.sports_follows
           (id, owner_user_id, competition_key, team_key, created_at)
         VALUES ($1, $2, 'nfl', '7', '2026-02-04T07:57:00.000Z'),
                ($3, $4, 'nba', '13', '2026-02-04T07:58:00.000Z')`,
        [sportsFollowA, ids.userA, sportsFollowB, ids.userB]
      );
      await seedPersonalRecords(client, ids.userA, "A", personalA);
      await seedPersonalRecords(client, ids.userB, "B", personalB);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("DELETE FROM app.sports_follows WHERE id = ANY($1::uuid[])", [
        [sportsFollowA, sportsFollowB]
      ]);
      await removePersonalRecords(client, [personalA, personalB]);
    } finally {
      await client.end();
    }
    await appDb?.destroy();
    await workerDb?.destroy();
  });

  it("archive holds the owner's personal records and none of another user's", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-personal-"));
    const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
    process.env.JARVIS_VAULT_ROOT = vaultRoot;
    try {
      const { handleExportBuildJob } =
        await import("../../packages/settings/src/data-export-jobs.js");
      const repository = new (
        await import("../../packages/settings/src/data-export-repository.js")
      ).DataExportRepository();
      const jobRecord = await new DataContextRunner(appDb).withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        (scopedDb) => repository.createJob(scopedDb, ids.userA)
      );

      await new DataContextRunner(workerDb).withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        (scopedDb) => {
          const jobPayload = {
            data: { actorUserId: ids.userA, jobId: jobRecord.id, kind: "export.build" as const }
          } as Job<ExportBuildJobPayload>;
          return handleExportBuildJob(jobPayload, scopedDb, () => getBuiltInModuleManifests());
        }
      );

      const archiveJson = await new VaultContextRunner(vaultRoot).withVaultContext(
        { actorUserId: ids.userA },
        (vaultCtx) => readVaultFile(vaultCtx, `exports/${jobRecord.id}.json`)
      );
      const sections = (JSON.parse(archiveJson) as { sections: Record<string, unknown> }).sections;
      const rowIds = (value: unknown, field = "id") =>
        (value as Record<string, unknown>[]).map((row) => row[field]);
      const memorySection = sections.memory as Record<string, unknown>;
      const goalsSection = sections.goals as Record<string, unknown>;
      const notificationsSection = sections.notifications as Record<string, unknown>;
      const feedbackSection = sections.usefulness_feedback as Record<string, unknown>;
      const sportsSection = sections.sportsSources as { follows: unknown[] };

      // Each section holds exactly the owner's row and none of userB's.
      expect(rowIds(memorySection.entities)).toEqual([personalA.entity]);
      expect(rowIds(memorySection.graphFacts)).toEqual([personalA.fact]);
      expect(rowIds(memorySection.episodes)).toEqual([personalA.episode]);
      expect(rowIds(memorySection.factSources, "factId")).toEqual([personalA.fact]);
      expect(rowIds(memorySection.aliases)).toEqual([personalA.alias]);
      expect(rowIds(memorySection.candidates)).toEqual([personalA.candidate]);
      expect(rowIds(memorySection.conflictGroups)).toEqual([personalA.conflictGroup]);
      expect(rowIds(goalsSection.goals)).toEqual([personalA.goal]);
      expect(rowIds(goalsSection.evidence)).toEqual([personalA.goalEvidence]);
      expect(rowIds(sections.task_activity)).toEqual([personalA.taskActivity]);
      expect(rowIds(notificationsSection.notifications)).toEqual([personalA.notification]);
      expect(rowIds(notificationsSection.reads, "notificationId")).toEqual([
        personalA.notification
      ]);
      expect(rowIds(sections.module_kv)).toEqual([personalA.moduleKv]);
      expect(rowIds(feedbackSection.signals)).toEqual([personalA.feedbackSignal]);
      expect(rowIds(feedbackSection.targets, "targetRef")).toEqual(["EXPORT-A-target"]);
      expect(rowIds(sections.action_audit_log)).toEqual([personalA.auditLog]);
      expect(rowIds(sportsSection.follows)).toEqual([sportsFollowA]);
      expect(archiveJson).toContain("EXPORT-A-");
      expect(archiveJson).not.toContain("EXPORT-B-");
      expect(archiveJson).not.toContain(sportsFollowB);
      for (const id of Object.values(personalB)) expect(archiveJson).not.toContain(id);
    } finally {
      if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
      else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
