import type { Page, Route } from "@playwright/test";
import type {
  BriefingDefinitionDto,
  BriefingRunDto,
  CreateBriefingDefinitionRequest,
  GetDayPlanResponse,
  UpdateBriefingDefinitionRequest
} from "@moss/shared";

export interface MockBriefingsApiState {
  briefingDefinitions?: BriefingDefinitionDto[];
  briefingRuns?: Record<string, BriefingRunDto[]>;
  dayPlan?: GetDayPlanResponse["plan"];
}

export async function registerMockBriefingsRoutes(
  page: Page,
  state: MockBriefingsApiState
): Promise<void> {
  await page.route(/\/api\/briefings\/definitions\/[^/]+\/run$/, (route) =>
    handleBriefingRunNowRoute(route, state)
  );
  await page.route(/\/api\/briefings\/definitions\/[^/]+\/runs$/, (route) =>
    handleBriefingRunsRoute(route, state)
  );
  await page.route(/\/api\/briefings\/definitions\/[^/]+$/, (route) =>
    handleBriefingDefinitionDetailRoute(route, state)
  );
  await page.route("**/api/briefings/definitions", (route) =>
    handleBriefingDefinitionsRoute(route, state)
  );
  await page.route("**/api/calendar/day-plan*", (route) => handleDayPlanRoute(route, state));
}

async function handleDayPlanRoute(route: Route, state: MockBriefingsApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, {
    plan: state.dayPlan ?? null,
    tasks: [],
    unavailableTaskIds: [],
    sourceRun: null,
    sourceRunUnavailable: false
  });
}

export function createMockBriefingDefinition(
  id: string,
  title: string,
  overrides: Partial<BriefingDefinitionDto> = {}
): BriefingDefinitionDto {
  return {
    id,
    ownerUserId: "user-1",
    title,
    cadence: "manual",
    scheduleMetadata: {},
    enabled: true,
    selectedToolNames: ["tasks.listVisible"],
    lastRunAt: null,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides,
    briefingType: overrides.briefingType ?? "morning"
  };
}

export function createMockBriefingRun(
  id: string,
  definitionId: string,
  summaryText: string,
  overrides: Partial<BriefingRunDto> = {}
): BriefingRunDto {
  return {
    id,
    definitionId,
    ownerUserId: "user-1",
    status: "succeeded",
    runKind: "manual",
    summaryText,
    sourceMetadata: {
      tools: [
        {
          name: "tasks.listVisible",
          status: "succeeded",
          itemCount: 1,
          excerpts: ["M6 briefings smoke source - todo"]
        }
      ]
    },
    feedbackItems: [],
    structuredPayload: { version: 1, actionRows: [], catchUp: null },
    createdAt: "2026-06-06T12:00:00.000Z",
    ...overrides,
    briefingType: overrides.briefingType ?? "morning"
  };
}

async function handleBriefingDefinitionsRoute(
  route: Route,
  state: MockBriefingsApiState
): Promise<void> {
  const request = route.request();

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { definitions: state.briefingDefinitions ?? [] });
  }

  if (request.method() === "POST") {
    const input = request.postDataJSON() as CreateBriefingDefinitionRequest;
    const definition = createMockBriefingDefinition(
      `briefing-${(state.briefingDefinitions ?? []).length + 1}`,
      input.title,
      {
        cadence: input.cadence ?? "manual",
        scheduleMetadata: input.scheduleMetadata ?? {},
        enabled: input.enabled ?? true,
        selectedToolNames: input.selectedToolNames
      }
    );

    state.briefingDefinitions = [definition, ...(state.briefingDefinitions ?? [])];
    state.briefingRuns = {
      ...(state.briefingRuns ?? {}),
      [definition.id]: []
    };

    return fulfillJson(route, 201, { definition });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleBriefingDefinitionDetailRoute(
  route: Route,
  state: MockBriefingsApiState
): Promise<void> {
  const request = route.request();
  const definitionId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const definition = (state.briefingDefinitions ?? []).find((item) => item.id === definitionId);

  if (!definition) {
    return fulfillJson(route, 404, { error: "Briefing definition not found" });
  }

  if (request.method() !== "PATCH") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const input = request.postDataJSON() as UpdateBriefingDefinitionRequest;
  const updatedDefinition: BriefingDefinitionDto = {
    ...definition,
    title: input.title ?? definition.title,
    cadence: input.cadence ?? definition.cadence,
    scheduleMetadata: input.scheduleMetadata ?? definition.scheduleMetadata,
    enabled: input.enabled ?? definition.enabled,
    selectedToolNames: input.selectedToolNames ?? definition.selectedToolNames,
    updatedAt: "2026-06-06T12:00:00.000Z"
  };

  state.briefingDefinitions = (state.briefingDefinitions ?? []).map((item) =>
    item.id === definitionId ? updatedDefinition : item
  );

  return fulfillJson(route, 200, { definition: updatedDefinition });
}

async function handleBriefingRunNowRoute(
  route: Route,
  state: MockBriefingsApiState
): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  const definitionId = decodeURIComponent(segments.at(-2) ?? "");
  const definition = (state.briefingDefinitions ?? []).find((item) => item.id === definitionId);

  if (!definition) {
    return fulfillJson(route, 404, { error: "Briefing definition not found" });
  }

  if (request.method() !== "POST") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const runId = `briefing-run-${Date.now()}`;
  const run = createMockBriefingRun(runId, definition.id, summaryForDefinition(definition));

  state.briefingRuns = {
    ...(state.briefingRuns ?? {}),
    [definition.id]: [run, ...(state.briefingRuns?.[definition.id] ?? [])]
  };
  state.briefingDefinitions = (state.briefingDefinitions ?? []).map((item) =>
    item.id === definition.id
      ? { ...item, lastRunAt: run.createdAt, updatedAt: "2026-06-06T12:00:00.000Z" }
      : item
  );

  return fulfillJson(route, 202, { jobId: "briefing-job-1", runId });
}

async function handleBriefingRunsRoute(route: Route, state: MockBriefingsApiState): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  const definitionId = decodeURIComponent(segments.at(-2) ?? "");

  if (request.method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  return fulfillJson(route, 200, { runs: state.briefingRuns?.[definitionId] ?? [] });
}

function summaryForDefinition(definition: BriefingDefinitionDto): string {
  if (definition.selectedToolNames.includes("tasks.listVisible")) {
    return "Tasks: 1 visible; top: M6 briefings smoke source - todo";
  }

  return "Briefing did not produce visible source items.";
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}
