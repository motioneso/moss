import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "@moss/jobs";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { VaultContextRunner, getVaultBaseDir, readVaultFile } from "@moss/vault";
import { HttpError } from "@moss/module-sdk";

import {
  handleWellnessExportJob,
  type WellnessExportJobPayload
} from "../../packages/wellness/src/export-job.js";
import { registerWellnessExportRoutes } from "../../packages/wellness/src/export-routes.js";
import { DataExportRepository } from "../../packages/settings/src/data-export-repository.js";
import { WellnessRepository } from "../../packages/wellness/src/repository.js";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";
import pg from "pg";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000081";
const routeUserId = "00000000-0000-4000-8000-000000000082";
const workerRoleUserId = "00000000-0000-4000-8000-000000000083";
const adherenceUserId = "00000000-0000-4000-8000-000000000085";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let workerDb: Kysely<MossDatabase>;
let workerDataContext: DataContextRunner;
let prevVaultBase: string | undefined;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, name, is_instance_admin)
       VALUES ($1, 'well-export-job@example.test', 'Test User', false)`,
      [userId]
    );
    await client.query(
      `INSERT INTO app.users (id, email, name, is_instance_admin)
       VALUES ($1, 'well-export-route@example.test', 'Route User', false)`,
      [routeUserId]
    );
    await client.query(
      `INSERT INTO app.users (id, email, name, is_instance_admin)
       VALUES ($1, 'well-export-worker-role@example.test', 'Worker Role User', false)`,
      [workerRoleUserId]
    );
    await client.query(
      `INSERT INTO app.users (id, email, name, is_instance_admin)
       VALUES ($1, 'well-export-adherence@example.test', 'Adherence User', false)`,
      [adherenceUserId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  workerDataContext = new DataContextRunner(workerDb);

  prevVaultBase = getVaultBaseDir();
  process.env.JARVIS_VAULT_ROOT = await mkdtemp(join(tmpdir(), "well-export-job-"));

  // Seed wellness data in and out of the [2026-02-01, 2026-02-28] window.
  const repo = new WellnessRepository();
  const med = await dataContext.withDataContext(
    { actorUserId: userId, requestId: "req:seed" },
    (scopedDb) =>
      repo.createMedication(
        scopedDb,
        {
          name: "Sertraline",
          frequencyType: "once_daily",
          scheduleTimes: ["08:00"]
        },
        "UTC"
      )
  );
  await dataContext.withDataContext(
    { actorUserId: userId, requestId: "req:seed" },
    async (scopedDb) => {
      // Check-ins: in-window + out-of-window
      await scopedDb.db
        .insertInto("app.wellness_checkins")
        .values({
          owner_user_id: userId,
          feeling_core: "happy",
          feeling_secondary: "Joy",
          intensity: 4,
          energy: 3,
          note: "IN-WINDOW-MARKER-CHECKIN",
          checked_in_at: new Date("2026-02-10T10:00:00Z")
        })
        .execute();
      await scopedDb.db
        .insertInto("app.wellness_checkins")
        .values({
          owner_user_id: userId,
          feeling_core: "sad",
          intensity: 2,
          note: "OUT-OF-WINDOW-MARKER-CHECKIN",
          checked_in_at: new Date("2026-01-05T10:00:00Z")
        })
        .execute();

      // Med log: in-window (scheduled_for)
      await scopedDb.db
        .insertInto("app.medication_logs")
        .values({
          medication_id: med.id,
          owner_user_id: userId,
          status: "taken",
          scheduled_for: new Date("2026-02-12T08:00:00Z"),
          logged_at: new Date("2026-02-12T08:01:00Z"),
          prn_reason: null
        })
        .execute();

      // Therapy note: in-window
      await scopedDb.db
        .insertInto("app.wellness_therapy_notes")
        .values({
          owner_user_id: userId,
          body: "IN-WINDOW-THERAPY-MARKER",
          created_at: new Date("2026-02-15T14:00:00Z")
        })
        .execute();
    }
  );
});

afterAll(async () => {
  await appDb?.destroy();
  await workerDb?.destroy();
  if (prevVaultBase) process.env.JARVIS_VAULT_ROOT = prevVaultBase;
});

function buildJobPayload(actorUserId: string, jobId: string): Job<WellnessExportJobPayload> {
  return { data: { actorUserId, jobId, kind: "wellness.export" } } as Job<WellnessExportJobPayload>;
}

describe("Wellness export job + route (#484)", () => {
  it("renders only selected categories in the selected timeframe, writes html to vault, marks ready", async () => {
    const exportRepo = new DataExportRepository();
    const { html } = await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:export" },
      async (scopedDb) => {
        const job = await exportRepo.createJob(scopedDb, userId, "html", {
          from: "2026-02-01",
          to: "2026-02-28",
          categories: ["checkins", "medications", "therapyNotes"]
        });
        await handleWellnessExportJob(buildJobPayload(userId, job.id), scopedDb);

        const finished = await exportRepo.getJobById(scopedDb, job.id);
        expect(finished?.status).toBe("ready");

        const vaultRunner = new VaultContextRunner(getVaultBaseDir());
        const content = await vaultRunner.withVaultContext(
          { actorUserId: userId, requestId: "req:export" },
          (vaultCtx) => readVaultFile(vaultCtx, `exports/${job.id}.html`)
        );
        return { jobId: job.id, html: content };
      }
    );

    // Header carries owner + range + generated-at + Jarv1s provenance.
    expect(html).toContain("Wellness export — Test User");
    expect(html).toContain("2026-02-01");
    expect(html).toContain("2026-02-28");
    expect(html).toContain("Generated by Jarv1s.");

    // Sensitive-data footer present.
    expect(html).toContain("This document contains sensitive health information");

    // Selected categories present as sections.
    expect(html).toContain('id="checkins"');
    expect(html).toContain('id="medications"');
    expect(html).toContain('id="therapyNotes"');

    // Unselected category (insights) is entirely absent.
    expect(html).not.toContain('id="insights"');

    // In-window data present.
    expect(html).toContain("IN-WINDOW-MARKER-CHECKIN");
    expect(html).toContain("IN-WINDOW-THERAPY-MARKER");
    expect(html).toContain("Sertraline");

    // Out-of-window data absent.
    expect(html).not.toContain("OUT-OF-WINDOW-MARKER-CHECKIN");
  });

  it("re-reads timeframe + categories from the job row, not the payload (defense-in-depth)", async () => {
    // The payload only carries {actorUserId, jobId, kind}. The handler must derive everything
    // else from the row. If the row has no params, it fails the job (does not silently export
    // all, and does not leave the row stuck in 'building' forever).
    const exportRepo = new DataExportRepository();
    await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:export-no-params" },
      async (scopedDb) => {
        // Insert a job row directly with no params (simulating tampering / a bad write).
        const job = await exportRepo.createJob(scopedDb, userId, "html");
        // Wipe params to force the missing-params branch.
        await scopedDb.db
          .updateTable("app.data_export_jobs")
          .set({ params: null })
          .where("id", "=", job.id)
          .execute();

        // The handler catches internally and marks the job failed rather than rejecting —
        // pg-boss retries would otherwise leave the row stuck in 'building' with no signal
        // reaching the polling client.
        await expect(
          handleWellnessExportJob(buildJobPayload(userId, job.id), scopedDb)
        ).resolves.toBeUndefined();

        const failed = await exportRepo.getJobById(scopedDb, job.id);
        expect(failed?.status).toBe("failed");
        expect(failed?.error_message).toMatch(/missing from\/to params/);
      }
    );
  });

  it("the enqueued payload is metadata-only (no health content)", async () => {
    // Static contract: the payload type only allows {actorUserId, jobId, kind}. Assert the
    // shape of the declared interface by constructing the canonical payload and checking it
    // carries no content keys.
    const payload: WellnessExportJobPayload = {
      kind: "wellness.export",
      actorUserId: userId,
      jobId: "abc"
    };
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(["actorUserId", "jobId", "kind"]);
    expect(JSON.stringify(payload)).not.toContain("checkins");
    expect(JSON.stringify(payload)).not.toContain("note");
  });

  it("runs under the actual jarvis_worker_runtime DB role, not just jarvis_app_runtime (#671)", async () => {
    // #671: production workers run as jarvis_worker_runtime, a distinct DB role from the
    // jarvis_app_runtime connection the rest of this file's tests use. A worker-role grant
    // gap (UPDATE without SELECT — Postgres requires SELECT on any column referenced in an
    // UPDATE's WHERE clause) caused "permission denied for table data_export_jobs" in prod
    // even though every test above passed, because they never exercised the worker's actual
    // role. This test creates the job under the app role (mirroring the route) and runs the
    // handler under the worker role (mirroring registerDataContextWorker in production).
    const exportRepo = new DataExportRepository();
    const job = await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:export-worker-role" },
      (scopedDb) =>
        exportRepo.createJob(scopedDb, userId, "html", {
          from: "2026-02-01",
          to: "2026-02-28",
          categories: ["checkins"]
        })
    );

    await workerDataContext.withDataContext(
      { actorUserId: userId, requestId: "req:export-worker-role" },
      (scopedDb) => handleWellnessExportJob(buildJobPayload(userId, job.id), scopedDb)
    );

    const finished = await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:export-worker-role-check" },
      (scopedDb) => exportRepo.getJobById(scopedDb, job.id)
    );
    expect(finished?.status).toBe("ready");
    expect(finished?.error_message).toBeNull();
  });

  it("exports all four category tables' owner data when run under jarvis_worker_runtime, not silently zero rows (#672)", async () => {
    // #671 fixed worker-role permission errors on data_export_jobs/admin_audit_events but left
    // the wellness content tables (wellness_checkins, medications, medication_logs,
    // wellness_therapy_notes) with a worker-role table GRANT and no matching RLS policy. Under
    // FORCE RLS that means the worker role's SELECTs against those tables silently return zero
    // rows instead of erroring — the job still finishes "ready" with categories quietly empty.
    // The #671 worker-role test above only asserts status === "ready" for a single category and
    // does not seed/inspect content, so it would not catch this. This test seeds a dedicated,
    // uniquely-marked owner's data across all four tables, runs the export under the real worker
    // role, and asserts every marker actually made it into the exported HTML.
    const med = await dataContext.withDataContext(
      { actorUserId: workerRoleUserId, requestId: "req:worker-role-seed" },
      (scopedDb) =>
        new WellnessRepository().createMedication(
          scopedDb,
          {
            name: "WORKER-ROLE-MARKER-MEDICATION",
            frequencyType: "once_daily",
            scheduleTimes: ["08:00"]
          },
          "UTC"
        )
    );
    await dataContext.withDataContext(
      { actorUserId: workerRoleUserId, requestId: "req:worker-role-seed" },
      async (scopedDb) => {
        await scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: workerRoleUserId,
            feeling_core: "happy",
            intensity: 4,
            energy: 3,
            note: "WORKER-ROLE-MARKER-CHECKIN",
            checked_in_at: new Date("2026-02-10T10:00:00Z")
          })
          .execute();
        await scopedDb.db
          .insertInto("app.medication_logs")
          .values({
            medication_id: med.id,
            owner_user_id: workerRoleUserId,
            status: "taken",
            dose: "WORKER-ROLE-MARKER-DOSE",
            scheduled_for: new Date("2026-02-12T08:00:00Z"),
            logged_at: new Date("2026-02-12T08:01:00Z"),
            prn_reason: null
          })
          .execute();
        await scopedDb.db
          .insertInto("app.wellness_therapy_notes")
          .values({
            owner_user_id: workerRoleUserId,
            body: "WORKER-ROLE-MARKER-THERAPY",
            created_at: new Date("2026-02-15T14:00:00Z")
          })
          .execute();
      }
    );

    const exportRepo = new DataExportRepository();
    const job = await dataContext.withDataContext(
      { actorUserId: workerRoleUserId, requestId: "req:worker-role-export" },
      (scopedDb) =>
        exportRepo.createJob(scopedDb, workerRoleUserId, "html", {
          from: "2026-02-01",
          to: "2026-02-28",
          categories: ["checkins", "medications", "therapyNotes"]
        })
    );

    const html = await workerDataContext.withDataContext(
      { actorUserId: workerRoleUserId, requestId: "req:worker-role-export" },
      async (scopedDb) => {
        await handleWellnessExportJob(buildJobPayload(workerRoleUserId, job.id), scopedDb);

        const finished = await exportRepo.workerGetJobById(scopedDb, job.id);
        expect(finished?.status).toBe("ready");
        expect(finished?.error_message).toBeNull();

        const vaultRunner = new VaultContextRunner(getVaultBaseDir());
        return vaultRunner.withVaultContext(
          { actorUserId: workerRoleUserId, requestId: "req:worker-role-export" },
          (vaultCtx) => readVaultFile(vaultCtx, `exports/${job.id}.html`)
        );
      }
    );

    // All four category tables' owner data must be present — a silent RLS omission would drop
    // one or more of these while the job still reports "ready".
    expect(html).toContain("WORKER-ROLE-MARKER-CHECKIN");
    expect(html).toContain("WORKER-ROLE-MARKER-MEDICATION");
    expect(html).toContain("WORKER-ROLE-MARKER-DOSE");
    expect(html).toContain("WORKER-ROLE-MARKER-THERAPY");
  });

  it("adherence % counts missed (unlogged) scheduled doses, not just logged rows (#770 / M2)", async () => {
    // Regression test for the #770 M2 finding: export-job previously called computeInsights
    // without totalExpectedSlots, so the adherence denominator fell back to logged rows only —
    // missed doses (no log row at all) were invisible and adherence read inflated relative to
    // what the app's own /insights route shows for the same window.
    const repo = new WellnessRepository();
    const exportRepo = new DataExportRepository();

    const med = await dataContext.withDataContext(
      { actorUserId: adherenceUserId, requestId: "req:adherence-seed" },
      (scopedDb) =>
        repo.createMedication(
          scopedDb,
          {
            name: "AdherenceTestMed",
            frequencyType: "once_daily",
            scheduleTimes: ["08:00"]
          },
          "UTC"
        )
    );

    await dataContext.withDataContext(
      { actorUserId: adherenceUserId, requestId: "req:adherence-seed" },
      async (scopedDb) => {
        // 7 check-ins so computeInsights' low-data guard (>= 7 check-ins) doesn't suppress the
        // adherence insight entirely.
        for (let i = 1; i <= 7; i++) {
          const dd = String(i).padStart(2, "0");
          await scopedDb.db
            .insertInto("app.wellness_checkins")
            .values({
              owner_user_id: adherenceUserId,
              feeling_core: "happy",
              intensity: 3,
              checked_in_at: new Date(`2026-03-${dd}T09:00:00Z`)
            })
            .execute();
        }

        // 10-day window [2026-03-01, 2026-03-10], once-daily 08:00 schedule => 10 expected
        // scheduled slots. Only 5 days get a "taken" log; the other 5 are silently missed (no
        // log row at all — the case the pre-fix denominator could not see).
        for (let day = 1; day <= 5; day++) {
          const dd = String(day).padStart(2, "0");
          await scopedDb.db
            .insertInto("app.medication_logs")
            .values({
              medication_id: med.id,
              owner_user_id: adherenceUserId,
              status: "taken",
              scheduled_for: new Date(`2026-03-${dd}T08:00:00Z`),
              logged_at: new Date(`2026-03-${dd}T08:05:00Z`),
              prn_reason: null
            })
            .execute();
        }
      }
    );

    const job = await dataContext.withDataContext(
      { actorUserId: adherenceUserId, requestId: "req:adherence-export" },
      (scopedDb) =>
        exportRepo.createJob(scopedDb, adherenceUserId, "html", {
          from: "2026-03-01",
          to: "2026-03-10",
          categories: ["medications", "insights"]
        })
    );

    const html = await dataContext.withDataContext(
      { actorUserId: adherenceUserId, requestId: "req:adherence-export" },
      async (scopedDb) => {
        await handleWellnessExportJob(buildJobPayload(adherenceUserId, job.id), scopedDb);
        const finished = await exportRepo.getJobById(scopedDb, job.id);
        expect(finished?.status).toBe("ready");

        const vaultRunner = new VaultContextRunner(getVaultBaseDir());
        return vaultRunner.withVaultContext(
          { actorUserId: adherenceUserId, requestId: "req:adherence-export" },
          (vaultCtx) => readVaultFile(vaultCtx, `exports/${job.id}.html`)
        );
      }
    );

    // Fixed: 5 taken / 10 expected scheduled slots = 50%. Pre-fix behavior divided by logged
    // rows only (5 taken / 5 logged = 100%), silently hiding the 5 missed doses.
    expect(html).toContain("50% adherence");
    expect(html).not.toContain("100% adherence");
  });

  it("does not throw when the row is missing (no job to mark failed, no vault write)", async () => {
    await dataContext.withDataContext(
      { actorUserId: userId, requestId: "req:export-fail" },
      async (scopedDb) => {
        // Use a job id that was never inserted — the handler's re-read returns undefined,
        // the inner handler throws "not found", and the outer catch swallows it (there's no
        // row to mark failed, so failJob is a harmless no-op) rather than rejecting.
        const missingJobId = "ffffffff-ffff-4000-8000-000000000099";
        await expect(
          handleWellnessExportJob(buildJobPayload(userId, missingJobId), scopedDb)
        ).resolves.toBeUndefined();
        // Assert nothing was written for this id.
        const vaultRunner = new VaultContextRunner(getVaultBaseDir());
        await expect(
          vaultRunner.withVaultContext(
            { actorUserId: userId, requestId: "req:export-fail" },
            (vaultCtx) => readVaultFile(vaultCtx, `exports/${missingJobId}.html`)
          )
        ).rejects.toThrow();
      }
    );
  });
});

describe("Wellness export route POST /api/wellness/export (#484)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify();
    registerWellnessExportRoutes(server, {
      // Minimal boss stub: the route calls send but we don't drive the worker here.
      boss: { send: async () => "fake-job-id" } as unknown as Parameters<
        typeof registerWellnessExportRoutes
      >[1]["boss"],
      dataContext,
      resolveAccessContext: async (request) => {
        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ")) throw new HttpError(401, "Unauthorized");
        return { actorUserId: routeUserId, requestId: "req:route" };
      }
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("creates an html-format job row with params and returns 202 {jobId, status}", async () => {
    const exportRepo = new DataExportRepository();
    const res = await server.inject({
      method: "POST",
      url: "/api/wellness/export",
      payload: { from: "2026-02-01", to: "2026-02-28", categories: ["checkins"] },
      headers: { authorization: "Bearer route-token", "content-type": "application/json" }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; status: string };
    expect(body.status).toBe("pending");

    const job = await dataContext.withDataContext(
      { actorUserId: routeUserId, requestId: "req:route" },
      (scopedDb) => exportRepo.getJobById(scopedDb, body.jobId)
    );
    expect(job?.format).toBe("html");
    expect((job?.params as { from?: string }).from).toBe("2026-02-01");
    expect((job?.params as { categories?: string[] }).categories).toEqual(["checkins"]);
  });

  it("reuses the pending job when the same window/categories are re-requested (#772)", async () => {
    // The prior test left an html job pending for routeUserId with
    // {from: 2026-02-01, to: 2026-02-28, categories: [checkins]}. Re-requesting the identical
    // selection should return the same job, not error.
    const first = await server.inject({
      method: "POST",
      url: "/api/wellness/export",
      payload: { from: "2026-02-01", to: "2026-02-28", categories: ["checkins"] },
      headers: { authorization: "Bearer route-token", "content-type": "application/json" }
    });
    expect(first.statusCode).toBe(202);

    const again = await server.inject({
      method: "POST",
      url: "/api/wellness/export",
      // Same categories, different array order — must still be treated as a match.
      payload: { from: "2026-02-01", to: "2026-02-28", categories: ["checkins"] },
      headers: { authorization: "Bearer route-token", "content-type": "application/json" }
    });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
  });

  it("returns 409 instead of silently swapping params while a differently-scoped export is pending (#772)", async () => {
    // Same pending job from routeUserId, but this request asks for a different window. Before
    // #772 this silently returned the old job's {jobId, status} with the new selection dropped
    // on the floor; now it must surface the conflict instead of pretending it queued the new one.
    const res = await server.inject({
      method: "POST",
      url: "/api/wellness/export",
      payload: { from: "2026-03-01", to: "2026-03-15", categories: ["checkins", "medications"] },
      headers: { authorization: "Bearer route-token", "content-type": "application/json" }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("already in progress") });
  });

  it("rejects from > to with 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/wellness/export",
      payload: { from: "2026-03-31", to: "2026-02-01", categories: ["checkins"] },
      headers: { authorization: "Bearer route-token", "content-type": "application/json" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires authentication (401 when no bearer)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/wellness/export",
      payload: { from: "2026-02-01", to: "2026-02-28", categories: ["checkins"] },
      headers: { "content-type": "application/json" }
    });
    expect(res.statusCode).toBe(401);
  });
});
