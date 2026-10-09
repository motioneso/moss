import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

import type { AccessContext, BriefingDefinition, DataContextDb, DataContextRunner } from "@moss/db";

import type { BriefingsRepository } from "../../packages/briefings/src/repository.js";
import {
  registerBriefingsRoutes,
  type BriefingsRoutesDependencies
} from "../../packages/briefings/src/routes.js";

const actor: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};

function buildApp(externalNames: readonly string[] | undefined) {
  const created: string[][] = [];
  const app = Fastify();
  const dependencies = {
    resolveAccessContext: async () => actor,
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    listModuleManifests: () => [],
    ...(externalNames ? { listExternalBriefingToolNames: () => externalNames } : {}),
    boss: {} as PgBoss,
    repository: {
      createDefinition: async (_db: unknown, input: { selectedToolNames: string[] }) => {
        created.push(input.selectedToolNames);
        return {
          id: "11111111-1111-1111-1111-111111111111",
          owner_user_id: actor.actorUserId,
          title: "t",
          briefing_type: "morning",
          cadence: "manual",
          schedule_metadata: {},
          enabled: true,
          selected_tool_names: input.selectedToolNames,
          created_at: new Date(),
          updated_at: new Date()
        } as unknown as BriefingDefinition;
      }
    } as unknown as BriefingsRepository
  } as BriefingsRoutesDependencies;
  registerBriefingsRoutes(app, dependencies);
  return { app, created };
}

async function create(app: ReturnType<typeof buildApp>["app"], names: string[]) {
  return app.inject({
    method: "POST",
    url: "/api/briefings/definitions",
    payload: { title: "Jobs", selectedToolNames: names }
  });
}

describe("briefing definitions and external module briefing tools", () => {
  it("accepts a briefing tool declared by an external module", async () => {
    const { app, created } = buildApp(["job-search.briefing"]);
    const response = await create(app, ["job-search.briefing"]);
    expect(response.statusCode).toBe(201);
    expect(created).toEqual([["job-search.briefing"]]);
  });

  it("still rejects a tool nobody declares", async () => {
    const { app } = buildApp(["job-search.briefing"]);
    const response = await create(app, ["job-search.other"]);
    expect(response.statusCode).toBe(400);
  });
});
