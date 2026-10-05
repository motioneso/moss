import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fastify, type FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Job } from "@moss/jobs";
import { collectMeetingsExportSection, type MeetingsExportSection } from "@moss/meetings";
import {
  createActiveModulesResolver,
  getBuiltInModuleManifests,
  getModuleDeletionTables
} from "@moss/module-registry";
import { HttpError } from "@moss/module-sdk";
import type { IngestMeetingTranscriptInput, MeetingOutputArtifact } from "@moss/shared";
import { readVaultFile, VaultContextRunner } from "@moss/vault";
import { DataExportRepository } from "../../packages/settings/src/data-export-repository.js";
import {
  handleExportBuildJob,
  type ExportBuildJobPayload
} from "../../packages/settings/src/data-export-jobs.js";
import { registerSettingsRoutes } from "../../packages/settings/src/routes.js";
import { SettingsRepository } from "../../packages/settings/src/repository.js";
import {
  camelCase,
  meetingExportTables,
  normalizeStoredRow,
  seedMeetingAccountExport,
  sortExportRows
} from "./meeting-account-export-fixtures.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

const actors = [
  { actorUserId: ids.userA, label: "owner", marker: "ACCOUNT-MEETING-OWNER-A" },
  { actorUserId: ids.userB, label: "other user", marker: "ACCOUNT-MEETING-OWNER-B" },
  { actorUserId: ids.adminUser, label: "instance admin", marker: "ACCOUNT-MEETING-ADMIN" }
] as const;
const fixtures = new Map<string, Awaited<ReturnType<typeof seedMeetingAccountExport>>>();
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let bootstrapDb: Kysely<MossDatabase>;
let appContext: DataContextRunner;
let workerContext: DataContextRunner;
let server: FastifyInstance;

beforeAll(async () => {
  // Hosted CI / the isolated verify-gate only. Never execute against an ambient database.
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  bootstrapDb = createDatabase({
    connectionString: connectionStrings.bootstrap,
    maxConnections: 1
  });
  appContext = new DataContextRunner(appDb);
  workerContext = new DataContextRunner(workerDb);
  for (const actor of actors) {
    fixtures.set(
      actor.actorUserId,
      await appContext.withDataContext(actor, (db) =>
        seedMeetingAccountExport(db, actor.marker, actor.actorUserId === ids.userA ? 101 : 1)
      )
    );
  }
  server = fastify();
  registerSettingsRoutes(server, {
    rootDb: appDb,
    dataContext: appContext,
    resolveAccessContext: async (request) => {
      const actor = actors.find(
        (candidate) => request.headers.authorization === `Bearer ${candidate.actorUserId}`
      );
      if (!actor) throw new HttpError(401, "Unauthorized");
      return { actorUserId: actor.actorUserId, requestId: "req:meeting-account-export" };
    },
    listModuleManifests: getBuiltInModuleManifests,
    moduleDeletionTables: getModuleDeletionTables()
  });
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await Promise.all([appDb?.destroy(), workerDb?.destroy(), bootstrapDb?.destroy()]);
});

function assertExportSection(section: MeetingsExportSection, actorUserId: string) {
  const fixture = fixtures.get(actorUserId)!;
  expect(Object.keys(section).sort()).toEqual(meetingExportTables.map(({ key }) => key).sort());
  for (const { key, columns } of meetingExportTables) {
    expect(section[key].length, `populated ${key}`).toBeGreaterThan(0);
    expect(sortExportRows(section[key])).toEqual(sortExportRows(fixture.expected[key]));
    for (const row of section[key]) {
      expect(row.ownerUserId).toBe(actorUserId);
      expect(Object.keys(row).sort()).toEqual(columns.map(camelCase).sort());
    }
  }
  const serialized = JSON.stringify(section);
  for (const actor of actors.filter((candidate) => candidate.actorUserId !== actorUserId)) {
    expect(serialized).not.toContain(actor.marker);
    expect(serialized).not.toContain(fixtures.get(actor.actorUserId)!.meetingId);
  }
  expect(serialized).not.toContain("historySearchTerms");
  expect(serialized).not.toContain("meeting_history_segments");
}

async function verifySettingsDownload(actorUserId: string) {
  const response = await server.inject({
    method: "GET",
    url: "/api/settings/me/data-export",
    headers: { authorization: `Bearer ${actorUserId}` }
  });
  expect(response.statusCode, response.payload).toBe(200);
  expect(response.headers["content-disposition"]).toContain("attachment;");
  const body = response.json<{
    userId: string;
    tables: { meetings: MeetingsExportSection; tasks: { id: string }[] };
  }>();
  expect(body.userId).toBe(actorUserId);
  assertExportSection(body.tables.meetings, actorUserId);
  expect(body.tables.tasks.map((task) => task.id)).toContain(
    fixtures.get(actorUserId)!.acceptedTaskId
  );
}

async function verifyWorkerArchive(actorUserId: string) {
  const actor = { actorUserId };
  const vaultRoot = await mkdtemp(join(tmpdir(), "moss-meeting-account-export-"));
  const previousVaultRoot = process.env.JARVIS_VAULT_ROOT;
  process.env.JARVIS_VAULT_ROOT = vaultRoot;
  try {
    const repository = new DataExportRepository();
    const jobRecord = await appContext.withDataContext(actor, (db) =>
      repository.createJob(db, actorUserId)
    );
    await workerContext.withDataContext(actor, (db) =>
      handleExportBuildJob(
        {
          data: { actorUserId: actorUserId, jobId: jobRecord.id, kind: "export.build" }
        } as Job<ExportBuildJobPayload>,
        db,
        getBuiltInModuleManifests
      )
    );
    const completed = await appContext.withDataContext(actor, (db) =>
      repository.getJobById(db, jobRecord.id)
    );
    expect(completed?.status, completed?.error_message ?? undefined).toBe("ready");
    const archiveJson = await new VaultContextRunner(vaultRoot).withVaultContext(actor, (ctx) =>
      readVaultFile(ctx, `exports/${jobRecord.id}.json`)
    );
    const archive = JSON.parse(archiveJson) as {
      format: string;
      userId: string;
      sections: { meetings: MeetingsExportSection; tasks: { id: string }[] };
    };
    expect(archive.format).toBe("jarvis-archive/v1");
    expect(archive.userId).toBe(actorUserId);
    assertExportSection(archive.sections.meetings, actorUserId);
    expect(archive.sections.tasks.map((task) => task.id)).toContain(
      fixtures.get(actorUserId)!.acceptedTaskId
    );
  } finally {
    if (previousVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
    else process.env.JARVIS_VAULT_ROOT = previousVaultRoot;
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

class OwnerIsolationFailure extends Error {}
function assertOwnerRows(rows: readonly Record<string, unknown>[], actorUserId: string) {
  if (rows.some((row) => row.owner_user_id !== actorUserId)) {
    throw new OwnerIsolationFailure("Meeting account export exposed another owner's marker");
  }
}

describe("Meetings full-account export", () => {
  for (const role of ["app", "worker"] as const) {
    it.each(actors.slice(1))(
      `${role} collector cannot export owner A through a $label transaction`,
      async (actor) => {
        const context = role === "app" ? appContext : workerContext;
        const section = await context.withDataContext(actor, (db) =>
          collectMeetingsExportSection(db, {
            actorUserId: ids.userA,
            requestId: "req:mismatched-export-context"
          })
        );
        expect(Object.keys(section).sort()).toEqual(
          meetingExportTables.map(({ key }) => key).sort()
        );
        for (const { key } of meetingExportTables) expect(section[key]).toEqual([]);
      }
    );
  }

  it.each(actors)("collector retains every source row for $label only", async (actor) => {
    const section = await appContext.withDataContext(actor, (db) =>
      collectMeetingsExportSection(db, {
        actorUserId: actor.actorUserId,
        requestId: "req:collector"
      })
    );
    assertExportSection(section, actor.actorUserId);
  });

  it("preserves superseded notes, transcript revisions/provenance, manual/stale outputs and accepted Task references", async () => {
    const fixture = fixtures.get(ids.userA)!;
    const section = await appContext.withDataContext({ actorUserId: ids.userA }, (db) =>
      collectMeetingsExportSection(db, {
        actorUserId: ids.userA,
        requestId: "req:retained-history"
      })
    );
    expect(section.note_writes.map((row) => row.expectedRevision)).toEqual([0, 1]);
    expect(section.note_writes[0]?.personalNotes).not.toEqual(section.records[0]?.personalNotes);
    const batches = section.transcript_batches.map(
      (row) => JSON.parse(String(row.inputJson)) as IngestMeetingTranscriptInput
    );
    expect(batches.map((batch) => batch.events[0]!.segment)).toMatchObject([
      { revision: 1, finality: "provisional", provenance: "transcription" },
      { revision: 2, finality: "final", provenance: "correction" }
    ]);
    expect(section.transcript_batches.map((row) => row.transcriptRevision)).toEqual([1, 2]);
    expect(batches[0]?.sources[0]?.label).toBe("Owner mic\ud800");
    const artifacts = section.output_artifacts.map(
      (row) => JSON.parse(String(row.artifactJson)) as MeetingOutputArtifact
    );
    expect(artifacts).toHaveLength(fixture.artifactCount);
    expect(artifacts.length).toBeGreaterThan(100);
    expect(artifacts.map((artifact) => artifact.version)).toEqual(
      Array.from({ length: fixture.artifactCount }, (_, index) => index + 1)
    );
    expect(artifacts[0]).toMatchObject({ origin: "generated", inputs: { notesRevision: 1 } });
    expect(artifacts[1]).toMatchObject({ origin: "manual", inputs: { notesRevision: 1 } });
    expect(artifacts.filter((artifact) => artifact.stale)).toHaveLength(101);
    expect(artifacts.at(-1)).toMatchObject({
      origin: "generated",
      stale: false,
      inputs: { notesRevision: 2, transcript: { transcriptRevision: 2 } }
    });
    expect(artifacts[0]?.content.overview).toContain("\0\ud800");
    expect(section.action_candidates.map((row) => row.reviewState).sort()).toEqual([
      "accepted",
      "dismissed",
      "pending"
    ]);
    const accepted = section.action_candidates.find((row) => row.reviewState === "accepted")!;
    expect(accepted.acceptedTaskId).toBe(fixture.acceptedTaskId);
    expect(section.action_candidates.at(-1)?.possibleMatchIds).toContain(accepted.id);
    expect(section.output_requests.some((row) => row.resultJson === null)).toBe(true);
    expect(section.output_requests.some((row) => String(row.inputJson).includes("\n"))).toBe(true);
    expect(section.export_requests.some((row) => row.resultJson === null)).toBe(true);
    expect(section.export_receipts).toHaveLength(3);
    assertExportSection(section, ids.userA);
  });

  it.each(actors)("real Settings sync download exposes tables.meetings for $label only", (actor) =>
    verifySettingsDownload(actor.actorUserId)
  );

  it.each(actors)("real worker archive exposes sections.meetings for $label only", (actor) =>
    verifyWorkerArchive(actor.actorUserId)
  );

  it.each(["app", "worker"] as const)(
    "%s collector returns all groups for an empty account",
    async (role) => {
      const actor = { actorUserId: ids.userC, requestId: "req:empty-meeting-export" };
      const context = role === "app" ? appContext : workerContext;
      const section = await context.withDataContext(actor, (db) =>
        collectMeetingsExportSection(db, actor)
      );
      expect(section).toEqual(Object.fromEntries(meetingExportTables.map(({ key }) => [key, []])));
    }
  );

  it("retains Meetings in the real Settings download and worker archive while disabled for the owner", async () => {
    const settings = new SettingsRepository();
    const actor = { actorUserId: ids.userA, requestId: "req:disabled-meeting-export" };
    const activeModules = createActiveModulesResolver({
      dataContext: appContext,
      manifests: getBuiltInModuleManifests
    });
    const wasDisabled = await appContext.withDataContext(actor, async (db) =>
      (await settings.listModuleDenyRowsForActor(db)).some(
        (row) => row.scope === "user" && row.module_id === "meetings" && row.user_id === ids.userA
      )
    );
    try {
      await appContext.withDataContext(actor, (db) =>
        settings.setUserModuleDisabled(db, {
          ...actor,
          moduleId: "meetings",
          disabled: true
        })
      );
      expect((await activeModules(ids.userA)).map((manifest) => manifest.id)).not.toContain(
        "meetings"
      );
      expect((await activeModules(ids.userB)).map((manifest) => manifest.id)).toContain("meetings");
      await verifySettingsDownload(ids.userA);
      await verifyWorkerArchive(ids.userA);
    } finally {
      await appContext.withDataContext(actor, (db) =>
        settings.setUserModuleDisabled(db, {
          ...actor,
          moduleId: "meetings",
          disabled: wasDisabled
        })
      );
    }
    expect((await activeModules(ids.userA)).some((manifest) => manifest.id === "meetings")).toBe(
      !wasDisabled
    );
  });
});

describe("Meetings export worker grants and owner RLS", () => {
  it("runtime roles cannot bypass forced RLS on any exported Meetings table", async () => {
    const roles = await sql<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>`
      SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
      WHERE rolname IN ('jarvis_app_runtime', 'jarvis_worker_runtime') ORDER BY rolname
    `.execute(bootstrapDb);
    expect(roles.rows).toEqual([
      { rolname: "jarvis_app_runtime", rolbypassrls: false, rolsuper: false },
      { rolname: "jarvis_worker_runtime", rolbypassrls: false, rolsuper: false }
    ]);
    for (const { table } of meetingExportTables) {
      const flags = await sql<{ enabled: boolean; forced: boolean }>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = ${`app.${table}`}::regclass
      `.execute(bootstrapDb);
      expect(flags.rows, table).toEqual([{ enabled: true, forced: true }]);
    }
  });

  it.each(actors)(
    "direct worker reads succeed with no owner WHERE and isolate $label on all eight tables",
    async (actor) => {
      await workerContext.withDataContext(actor, async (db) => {
        for (const { key, table, columns } of meetingExportTables) {
          const { rows } = await sql<Record<string, unknown>>`
          SELECT ${sql.join(columns.map((column) => sql.ref(column)))}
          FROM ${sql.table(`app.${table}`)}
        `.execute(db.db);
          expect(rows.length, table).toBeGreaterThan(0);
          assertOwnerRows(rows, actor.actorUserId);
          expect(sortExportRows(rows.map(normalizeStoredRow))).toEqual(
            sortExportRows(fixtures.get(actor.actorUserId)!.expected[key])
          );
        }
      });
    }
  );

  it.each(meetingExportTables)(
    "$table grants only the original SELECT columns and no write columns",
    async ({ table, columns, derived }) => {
      const qualified = `app.${table}`;
      const privileges = await sql<{
        table_select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>`
        SELECT
          has_table_privilege('jarvis_worker_runtime', ${qualified}, 'SELECT') AS table_select,
          has_any_column_privilege('jarvis_worker_runtime', ${qualified}, 'INSERT') AS "insert",
          has_any_column_privilege('jarvis_worker_runtime', ${qualified}, 'UPDATE') AS "update",
          has_table_privilege('jarvis_worker_runtime', ${qualified}, 'DELETE') AS "delete"
      `.execute(bootstrapDb);
      expect(privileges.rows).toEqual([
        { table_select: false, insert: false, update: false, delete: false }
      ]);
      const columnPrivileges = await sql<{ column_name: string; readable: boolean }>`
        SELECT column_name,
          has_column_privilege('jarvis_worker_runtime', ${qualified}, column_name, 'SELECT') AS readable
        FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = ${table}
      `.execute(bootstrapDb);
      expect(columnPrivileges.rows.map((row) => row.column_name).sort()).toEqual(
        [...columns, ...derived].sort()
      );
      for (const column of columnPrivileges.rows) {
        expect(column.readable, `${table}.${column.column_name}`).toBe(
          columns.some((original) => original === column.column_name)
        );
      }
    }
  );

  for (const { table, columns, derived } of meetingExportTables) {
    it.each(["INSERT", "UPDATE", "DELETE"] as const)(
      `worker cannot %s ${table}`,
      async (operation) => {
        const qualified = sql.table(`app.${table}`);
        const columnList = sql.join(columns.map((column) => sql.ref(column)));
        const statement =
          operation === "INSERT"
            ? sql`INSERT INTO ${qualified} (${columnList}) SELECT ${columnList} FROM ${qualified} WHERE owner_user_id = ${ids.userA}::uuid`
            : operation === "UPDATE"
              ? sql`UPDATE ${qualified} SET owner_user_id = owner_user_id WHERE owner_user_id = ${ids.userA}::uuid`
              : sql`DELETE FROM ${qualified} WHERE owner_user_id = ${ids.userA}::uuid`;
        // Each denied command owns its transaction; an earlier SQL error cannot mask a later one.
        await expect(
          workerContext.withDataContext({ actorUserId: ids.userA }, (db) =>
            statement.execute(db.db)
          )
        ).rejects.toThrow(/permission denied/i);
      }
    );

    for (const column of derived) {
      it(`worker cannot read derived ${table}.${column}`, async () => {
        await expect(
          workerContext.withDataContext({ actorUserId: ids.userA }, (db) =>
            sql`SELECT ${sql.ref(column)} FROM ${sql.table(`app.${table}`)}`.execute(db.db)
          )
        ).rejects.toThrow(/permission denied/i);
      });
    }

    it(`owner assertion fails when ${table} worker policy is weakened, then rollback restores it`, async () => {
      const policy = `${table}_export_worker`;
      const before = await sql<{ qual: string; roles: string[]; cmd: string }>`
        SELECT qual, roles::text[] AS roles, cmd FROM pg_policies
        WHERE schemaname = 'app' AND tablename = ${table} AND policyname = ${policy}
      `.execute(bootstrapDb);
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({ roles: ["jarvis_worker_runtime"], cmd: "SELECT" });
      await expect(
        bootstrapDb.transaction().execute(async (transaction) => {
          await sql`ALTER POLICY ${sql.id(policy)} ON ${sql.table(`app.${table}`)} USING (true)`.execute(
            transaction
          );
          await sql`SET LOCAL ROLE jarvis_worker_runtime`.execute(transaction);
          await sql`SELECT set_config('app.actor_user_id', ${ids.userB}, true)`.execute(
            transaction
          );
          const { rows } = await sql<Record<string, unknown>>`
          SELECT owner_user_id FROM ${sql.table(`app.${table}`)}
        `.execute(transaction);
          expect(rows.some((row) => row.owner_user_id === ids.userA)).toBe(true);
          // This is the same assertion used by the passing direct-worker isolation test above.
          assertOwnerRows(rows, ids.userB);
          throw new Error("Weakening the policy did not defeat the owner assertion");
        })
      ).rejects.toBeInstanceOf(OwnerIsolationFailure);
      const after = await sql<{ qual: string; roles: string[]; cmd: string }>`
        SELECT qual, roles::text[] AS roles, cmd FROM pg_policies
        WHERE schemaname = 'app' AND tablename = ${table} AND policyname = ${policy}
      `.execute(bootstrapDb);
      expect(after.rows).toEqual(before.rows);
      const flags = await sql<{ enabled: boolean; forced: boolean }>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = ${`app.${table}`}::regclass
      `.execute(bootstrapDb);
      expect(flags.rows).toEqual([{ enabled: true, forced: true }]);
      await workerContext.withDataContext({ actorUserId: ids.userB }, async (db) => {
        const { rows } = await sql<Record<string, unknown>>`
          SELECT owner_user_id FROM ${sql.table(`app.${table}`)}
        `.execute(db.db);
        expect(rows.length).toBeGreaterThan(0);
        assertOwnerRows(rows, ids.userB);
      });
    });
  }

  it("worker cannot read the populated history segment/search-term projection", async () => {
    const projection = await appContext.withDataContext({ actorUserId: ids.userA }, (db) =>
      db.db.selectFrom("app.meeting_history_segments").select("search_terms").execute()
    );
    expect(projection.length).toBeGreaterThan(0);
    expect(projection[0]?.search_terms.length).toBeGreaterThan(0);
    await expect(
      workerContext.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db.selectFrom("app.meeting_history_segments").select("search_terms").execute()
      )
    ).rejects.toThrow(/permission denied/i);
  });
});
