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

function buildApp(
  externalNames: readonly string[] | undefined,
  externalSources?: readonly { toolName: string; label: string }[],
  onSourcesAsked?: (access: unknown) => void
) {
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
    ...(externalSources
      ? {
          listExternalBriefingSources: async (access: unknown) => {
            onSourcesAsked?.(access);
            return externalSources;
          }
        }
      : {}),
    boss: {} as PgBoss,
    repository: {
      listDefinitions: async () => [],
      listOwnedForSchedules: async () => [],
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

  it("lists the installed modules' briefing sources so settings can offer them", async () => {
    const { app } = buildApp(undefined, [{ toolName: "job-search.briefing", label: "Job Search" }]);
    const response = await app.inject({ method: "GET", url: "/api/briefings/definitions" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      definitions: [],
      externalSources: [{ toolName: "job-search.briefing", label: "Job Search" }]
    });
  });

  it("asks for sources on behalf of the signed-in user so switched-off modules can be hidden", async () => {
    const seen: unknown[] = [];
    const { app } = buildApp(undefined, [], (access) => seen.push(access));
    await app.inject({ method: "GET", url: "/api/briefings/definitions" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ actorUserId: expect.any(String) });
  });

  it("returns no external sources when no module offers one", async () => {
    const { app } = buildApp(undefined);
    const response = await app.inject({ method: "GET", url: "/api/briefings/definitions" });
    expect(response.json()).toEqual({ definitions: [], externalSources: [] });
  });
});
