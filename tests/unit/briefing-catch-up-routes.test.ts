import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

import type {
  AccessContext,
  BriefingDefinition,
  BriefingRun,
  DataContextDb,
  DataContextRunner
} from "@moss/db";
import type { BriefingCatchUpEntryDto } from "@moss/shared";

import type { BriefingsRepository } from "../../packages/briefings/src/repository.js";
import {
  registerBriefingsRoutes,
  type BriefingsRoutesDependencies
} from "../../packages/briefings/src/routes.js";

const actor: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};
const definitionId = "11111111-1111-1111-1111-111111111111";

function entry(id: string): BriefingCatchUpEntryDto {
  return {
    id,
    senderName: `Sender ${id}`,
    summary: `Summary ${id}`,
    receivedAt: "2026-06-13T09:00:00.000Z",
    reason: null,
    cacheMessageId: null,
    openHref: null
  };
}

function run(id: string, catchUp: unknown): BriefingRun {
  return {
    id,
    definition_id: definitionId,
    owner_user_id: actor.actorUserId,
    status: "succeeded",
    run_kind: "scheduled",
    briefing_type: "morning",
    summary_text: "Morning.",
    source_metadata: { structuredPayload: { version: 1, actionRows: [], catchUp } },
    created_at: new Date("2026-06-13T12:00:00.000Z")
  } as unknown as BriefingRun;
}

function buildApp(runs: readonly BriefingRun[], handled: readonly string[]) {
  const upserted: string[] = [];
  const kindsAsked: string[][] = [];
  const app = Fastify();
  const dependencies: BriefingsRoutesDependencies = {
    resolveAccessContext: async () => actor,
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    listModuleManifests: () => [],
    boss: {} as PgBoss,
    repository: {
      getDefinitionById: async () => ({ id: definitionId }) as BriefingDefinition,
      listRuns: async () => runs
    } as unknown as BriefingsRepository,
    feedbackRepository: {
      upsertTarget: async (_db, input) => {
        if (input.targetRef.startsWith("email-digest:")) upserted.push(input.targetRef);
      },
      listActiveDismissedRefs: async () => new Set<string>(),
      listActiveRefs: async (_db, _owner, _kind, _surface, kinds) => {
        kindsAsked.push([...kinds]);
        return new Set(handled);
      }
    }
  };
  registerBriefingsRoutes(app, dependencies);
  return { app, upserted, kindsAsked };
}

async function listCatchUps(app: ReturnType<typeof Fastify>) {
  await app.ready();
  const res = await app.inject({
    method: "GET",
    url: `/api/briefings/definitions/${definitionId}/runs`
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { runs: { structuredPayload: { catchUp: unknown } }[] }).runs.map(
    (item) => item.structuredPayload.catchUp
  );
}

const catchUp = (entries: readonly BriefingCatchUpEntryDto[]) => ({
  source: "email",
  itemCount: entries.length,
  since: "2026-06-13T07:00:00.000Z",
  leftOutCount: 3,
  asOf: null,
  entries
});

describe("briefing runs route: catch-up digest (#3028)", () => {
  it("drops entries the user dismissed or turned into a task", async () => {
    const { app, kindsAsked } = buildApp(
      [run("run-1", catchUp([entry("email-digest:a"), entry("email-digest:b")]))],
      ["email-digest:a"]
    );

    const [shown] = await listCatchUps(app);

    expect(shown).toMatchObject({ itemCount: 1, leftOutCount: 3 });
    expect((shown as { entries: { id: string }[] }).entries.map((item) => item.id)).toEqual([
      "email-digest:b"
    ]);
    expect(kindsAsked).toContainEqual(["dismiss", "more_like_this"]);
    await app.close();
  });

  it("drops the whole block once every entry is handled", async () => {
    const { app } = buildApp(
      [run("run-1", catchUp([entry("email-digest:a")]))],
      ["email-digest:a"]
    );
    expect(await listCatchUps(app)).toEqual([null]);
    await app.close();
  });

  it("reads a catch-up stored before the digest as absent", async () => {
    const { app } = buildApp(
      [
        run("run-old", {
          source: "email",
          itemCount: 4,
          summaryText: "one\ntwo",
          asOf: null
        })
      ],
      []
    );
    expect(await listCatchUps(app)).toEqual([null]);
    await app.close();
  });

  it("registers each entry as a feedback target so it can be dismissed", async () => {
    const { app, upserted } = buildApp(
      [
        run("run-1", catchUp([entry("email-digest:a"), entry("email-digest:b")])),
        run("run-2", catchUp([entry("email-digest:a")]))
      ],
      []
    );
    await listCatchUps(app);
    expect(upserted).toEqual(["email-digest:a", "email-digest:b"]);
    await app.close();
  });
});
