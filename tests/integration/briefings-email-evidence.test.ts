import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import {
  adminContext,
  briefingIds,
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userAHeaders,
  userBContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";
import { connectionStrings, ids } from "./test-database.js";

// This suite always runs inside the gate's disposable database.
describe("saved briefing email evidence stays owner-only (#3465)", () => {
  let h: BriefingsTestHarness;
  beforeAll(async () => {
    h = await setupBriefingsHarness();
  });
  afterAll(async () => {
    await teardownBriefingsHarness(h);
  });

  it("persists evidence on fallback runs and denies shared users and admins on app and worker readers", async () => {
    const messages = [
      {
        id: "invoice",
        connectorAccountId: "account",
        sender: "Vendor",
        subject: "Invoice #42",
        receivedAt: "2026-09-01T15:00:00Z",
        actionability: "fyi",
        awaitingJudgement: true
      },
      {
        id: "receipt",
        connectorAccountId: "account",
        sender: "Vendor",
        subject: "Invoice #42 paid in full",
        receivedAt: "2026-09-15T15:00:00Z",
        actionability: "receipt_or_notice"
      }
    ];
    const manifests = getBuiltInModuleManifests().map((m) => ({
      ...m,
      assistantTools: m.assistantTools?.map((t) =>
        t.name === "email.listVisibleMessages"
          ? { ...t, execute: async () => ({ data: { messages } }) }
          : t
      )
    }));
    await h.dataContext.withDataContext(userBContext(), (db) =>
      h.repository.updateDefinition(db, briefingIds.userBWorkspace, {
        selectedToolNames: ["email.listVisibleMessages"]
      })
    );
    const outcome = await h.dataContext.withDataContext(userBContext(), (db) =>
      h.repository.generateRun(db, briefingIds.userBWorkspace, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: makeComposeDeps(undefined, manifests)
      })
    );
    const run = outcome!.run!;
    expect(run.source_metadata.emailEvidence).toMatchObject({
      version: 1,
      items: expect.arrayContaining([
        expect.objectContaining({
          messageId: "invoice",
          status: "settled",
          contraryMessageIds: ["receipt"]
        })
      ])
    });
    await h.dataContext.withDataContext(userBContext(), (db) =>
      h.sharesRepository.grant(db, {
        resourceType: "briefing_definition",
        resourceId: briefingIds.userBWorkspace,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      })
    );
    expect(
      await h.dataContext.withDataContext(userAContext(), (db) =>
        h.repository.getDefinitionById(db, briefingIds.userBWorkspace)
      )
    ).toBeDefined();
    const listResponse = await h.server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${briefingIds.userBWorkspace}/runs`,
      headers: userAHeaders()
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().runs).toEqual([]);
    const detailResponse = await h.server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${briefingIds.userBWorkspace}/runs/${run.id}`,
      headers: userAHeaders()
    });
    expect(detailResponse.statusCode).toBe(404);
    expect(detailResponse.body).not.toContain("emailEvidence");
    const assertPrivate = async () => {
      for (const runner of [h.dataContext, new DataContextRunner(h.workerDb)]) {
        for (const actor of [userAContext(), adminContext()]) {
          expect(
            await runner.withDataContext(actor, (db) =>
              h.repository.listRuns(db, briefingIds.userBWorkspace)
            )
          ).toEqual([]);
          expect(
            await runner.withDataContext(actor, (db) => h.repository.getOwnedRunById(db, run.id))
          ).toBeUndefined();
          expect(
            await runner.withDataContext(actor, (db) =>
              db.db
                .selectFrom("app.briefing_runs")
                .select("source_metadata")
                .where("id", "=", run.id)
                .execute()
            )
          ).toEqual([]);
        }
        expect(
          await runner.withDataContext(userBContext(), (db) =>
            h.repository.getOwnedRunById(db, run.id)
          )
        ).toMatchObject({ source_metadata: { emailEvidence: run.source_metadata.emailEvidence } });
      }
    };
    await assertPrivate();

    // Negative control: prove the assertion detects a leak with RLS protection removed.
    const client = new pg.Client({ connectionString: connectionStrings.migration });
    await client.connect();
    let detectedLeak = false;
    try {
      await client.query("ALTER POLICY briefing_runs_select ON app.briefing_runs USING (true)");
      try {
        await assertPrivate();
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AssertionError") throw error;
        detectedLeak = true;
      }
    } finally {
      await client.query(
        await readFile("packages/briefings/sql/0085_briefing_runs_owner_only_select.sql", "utf8")
      );
      await client.end();
    }
    expect(detectedLeak, "owner-only assertion must fail when SELECT protection is removed").toBe(
      true
    );
    await assertPrivate();
  });
});
