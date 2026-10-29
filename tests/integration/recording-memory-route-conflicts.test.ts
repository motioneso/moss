import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerMemoryDashboardRoutes, registerMemoryGraphRoutes } from "@moss/memory";
import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";

const { setup } = useRecordingMemoryFixture();

describe("recording memory route conflicts", () => {
  it.each(["generation", "fence"] as const)(
    "returns actionable conflicts from registered mutations after a source %s",
    async (boundary) => {
      const { runner, owner, service, graph, create, flip, lifecycle } = await setup("app");
      const source = await create();
      const proposal = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic route conflict memory"
      });
      const { receipt } = await service.apply(owner, { proposalId: proposal.id });
      if (boundary === "generation") await flip(source);
      else
        await lifecycle.fenceSource(owner, {
          ownerUserId: owner.actorUserId,
          sourceModuleId: "meetings",
          sourceId: source.sourceId
        });
      const server = Fastify();
      const dependencies = {
        dataContext: runner,
        graphRepository: graph,
        resolveAccessContext: async () => owner
      };
      registerMemoryGraphRoutes(server, dependencies);
      registerMemoryDashboardRoutes(server, dependencies);
      try {
        for (const request of [
          {
            method: "PATCH" as const,
            url: `/api/memory/graph/facts/${receipt.fact!.id}`,
            payload: { pinned: true }
          },
          {
            method: "POST" as const,
            url: `/api/memory/graph/facts/${receipt.fact!.id}/correct`,
            payload: { replacementText: "Synthetic corrected route memory" }
          },
          { method: "DELETE" as const, url: `/api/memory/graph/facts/${receipt.fact!.id}` }
        ]) {
          const response = await server.inject(request);
          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject({ error: expect.stringContaining("refresh") });
        }
        expect((await service.inspect(owner, source))?.fact?.text).toBe(
          "Synthetic route conflict memory"
        );
      } finally {
        await server.close();
      }
    }
  );
});
