import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import type { GetBriefingRunResponse, ListBriefingRunsResponse } from "@moss/shared";

import {
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userAHeaders,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

// A fallback run stays stored, but the API never returns its digest text. The Today
// hero and reader render only a non-empty summary, so this is what keeps it off screen.
describe("fallback briefing text never leaves the API", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: BriefingsTestHarness["dataContext"];
  let repository: BriefingsTestHarness["repository"];
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    dataContext = harness.dataContext;
    repository = harness.repository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
  });

  afterAll(async () => {
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
  });

  it("stores the fallback digest but serves an empty summary", async () => {
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Fallback briefing",
        selectedToolNames: ["tasks.list"]
      })
    );

    // With no model this is no_model; with one, the throwing adapter makes it
    // synthesis_failed. Either way compose writes the fallback digest.
    const outcome = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps(async () => {
          throw new Error("provider down");
        })
      })
    );
    const stored = outcome?.run;
    expect(stored?.status).toBe("succeeded");
    expect(stored?.summary_text).toContain("TASKS:");
    expect(stored?.source_metadata).toMatchObject({ degraded: true, aiModel: null });

    const listResponse = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs`,
      headers: userAHeaders()
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listResponse.json<ListBriefingRunsResponse>().runs;
    expect(listed.map((run) => run.id)).toContain(stored?.id);
    for (const run of listed) expect(run.summaryText).toBe("");

    const readResponse = await server.inject({
      method: "GET",
      url: `/api/briefings/definitions/${definition.id}/runs/${stored?.id}`,
      headers: userAHeaders()
    });
    expect(readResponse.statusCode).toBe(200);
    const read = readResponse.json<GetBriefingRunResponse>();
    expect(read.state).toBe("ready");
    expect(read.run?.summaryText).toBe("");

    const body = listResponse.body + readResponse.body;
    expect(body).not.toContain("TASKS:");
    expect(body).not.toContain("COMMITMENTS:");
  });
});
