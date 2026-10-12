// @vitest-environment jsdom
import Fastify from "fastify";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { DataContextRunner } from "@moss/db";
import { GoalsRepository } from "../../packages/goals/src/repository.js";
import { registerGoalsRoutes } from "../../packages/goals/src/routes.js";
import type { MossGoal } from "../../packages/goals/src/types.js";
import { GoalsSection } from "../../apps/web/src/today/goals-section.js";

vi.mock("@moss/jobs", () => ({ sendJob: vi.fn() }));
vi.mock("../../packages/goals/src/manifest.js", () => ({
  GOALS_MEMORY_SYNC_QUEUE: "goals-memory-sync"
}));

const goal: MossGoal = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  title: "Finish the first chapter",
  desiredOutcome: "A complete draft",
  status: "active",
  priority: 3,
  reviewCadence: "weekly",
  nextReviewAt: null,
  targetAt: null,
  lastProgressSummary: null,
  lastProgressAt: null,
  blockerSummary: null,
  nextSuggestedAction: null,
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  completedAt: null,
  archivedAt: null
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Repository I/O is a unit-test seam. The route's schema, serialization, real web
// client and Today component run together; this does not replace live DB/UI proof.
it("renders a goal through the route's real array response and the actual web client", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const repository = new GoalsRepository();
  vi.spyOn(repository, "list").mockResolvedValue([goal]);
  const dataContext = new DataContextRunner({} as never);
  vi.spyOn(dataContext, "withDataContext").mockImplementation(async (_access, read) =>
    read({} as never)
  );
  const app = Fastify();
  registerGoalsRoutes(app, {
    repository,
    dataContext,
    boss: {} as never,
    resolveAccessContext: async () => ({ actorUserId: goal.ownerUserId })
  });
  const route = await app.inject({ method: "GET", url: "/api/goals" });
  expect(route.statusCode).toBe(200);
  expect(route.json()).toEqual([goal]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe("/api/goals");
      const response = await app.inject({ method: "GET", url });
      return new Response(response.body, { status: response.statusCode });
    })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <GoalsSection />
        </QueryClientProvider>
      )
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(container.textContent).toContain(goal.title);
    });
    expect(container.textContent).toContain(goal.desiredOutcome);
  } finally {
    act(() => root.unmount());
    client.clear();
    container.remove();
    await app.close();
  }
});
