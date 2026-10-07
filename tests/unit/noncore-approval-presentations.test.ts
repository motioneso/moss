import { configureGoalApprovalReferences } from "../../packages/goals/src/approval-presentation.js";
import type * as SportsChatTools from "../../packages/sports/src/chat-tools.js";
import { backtrackModuleManifest } from "../../packages/backtrack/src/manifest.js";
import { briefingsModuleManifest } from "../../packages/briefings/src/manifest.js";
import { BriefingsRepository } from "../../packages/briefings/src/repository.js";
import {
  createSportsPreviewStore,
  type PendingSportsSourcePreview
} from "../../packages/sports/src/source/preview-store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { MossModuleManifest, ToolContext, HumanActionDetails } from "@moss/module-sdk";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";
import { scratchpadModuleManifest } from "../../packages/scratchpad/src/manifest.js";
import { notificationsModuleManifest } from "../../packages/notifications/src/manifest.js";
import { wellnessModuleManifest } from "../../packages/wellness/src/manifest.js";
import { workshopModuleManifest } from "../../packages/workshop/src/manifest.js";
import { goalsModuleManifest } from "../../packages/goals/src/manifest.js";
import { commitmentsModuleManifest } from "../../packages/commitments/src/manifest.js";
import { peopleModuleManifest } from "../../packages/people/src/manifest.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import { usefulnessFeedbackModuleManifest } from "../../packages/usefulness-feedback/src/manifest.js";
import { GoalsRepository } from "../../packages/goals/src/repository.js";
import { FeedbackTargetVerifierRegistry } from "../../packages/usefulness-feedback/src/target-verifiers.js";
import { configureUsefulnessFeedbackPresentation } from "../../packages/usefulness-feedback/src/approval-presentation.js";
import { taskApprovalActions } from "../../packages/tasks/src/approval-presentation.js";

const state = vi.hoisted(() => ({
  teamId: "permanent-team",
  teamName: "Dallas Cowboys",
  previewOwner: "owner",
  previewKind: "new-source"
}));
vi.mock("../../packages/sports/src/chat-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SportsChatTools>()),
  sportsApprovalTeams: async () => ({
    teams: [{ teamKey: "dal", name: state.teamName, sourceTeamId: state.teamId }],
    degraded: false
  }),
  sportsApprovalStandings: async () => ({
    group: { sections: [{ label: "East", conference: "Conference", rows: [] }] }
  }),
  sportsApprovalPreview: (owner: string) =>
    owner === state.previewOwner
      ? {
          kind: state.previewKind,
          ...(state.previewKind !== "new-source"
            ? { sourceId: "11111111-1111-4111-8111-111111111111" }
            : {}),
          ownerUserId: owner,
          createdAt: 1,
          authorizationAcknowledgement: "I authorize this publisher",
          candidate: {
            label: "Sports Daily",
            canonicalDomain: "sports.example",
            confirmedFetchHosts: ["sports.example"],
            targets: [
              {
                target: { kind: "sport", sportKey: "football" },
                targetUrl: "https://sports.example/football"
              }
            ]
          }
        }
      : null
}));

const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const date = new Date("2026-10-07T10:00:00Z");
const ctx: ToolContext = {
  actorUserId: "owner",
  requestId: "request",
  chatSessionId: "chat"
} as ToolContext;
const longText = `Exact content\n${"abc<>& ".repeat(700)}`;
const manifests: readonly MossModuleManifest[] = [
  tasksModuleManifest,
  scratchpadModuleManifest,
  notificationsModuleManifest,
  wellnessModuleManifest,
  workshopModuleManifest,
  goalsModuleManifest,
  commitmentsModuleManifest,
  peopleModuleManifest,
  sportsModuleManifest,
  usefulnessFeedbackModuleManifest,
  backtrackModuleManifest,
  briefingsModuleManifest
];

function scoped() {
  const rows: Record<string, Record<string, unknown>[]> = {
    "app.tasks": [{ id, title: "Write launch plan", updated_at: date }],
    "app.task_lists": [
      { id, name: "Work" },
      { id: second, name: "Personal" }
    ],
    "app.task_tags": [{ id, name: "Important", list_id: id }],
    "app.notifications": [{ id, title: "Launch ready", created_at: date }],
    "app.wellness_checkins": [{ id, checked_in_at: date, created_at: date }],
    "app.workshop_projects": [{ id, title: "Garden planner", owner_user_id: "owner" }],
    "app.commitment_candidates": [
      {
        id,
        title: "Send proposal",
        updated_at: date,
        status: "explicit_non_action",
        owner_user_id: "owner"
      }
    ],
    "app.person_context_match_candidates": [
      {
        id,
        owner_user_id: "owner",
        candidate_kind: "create_person",
        suggested_display_name: "Alex",
        updated_at: date
      }
    ],
    "app.person_context_people": [
      { id, display_name: "Alex", owner_user_id: "owner", status: "active", updated_at: date },
      {
        id: second,
        display_name: "Jordan",
        owner_user_id: "owner",
        status: "active",
        updated_at: date
      }
    ],
    "app.person_context_identities": [
      {
        id,
        display_value: "alex@example.com",
        person_id: id,
        owner_user_id: "owner",
        updated_at: date
      }
    ],
    "app.sports_follows": [
      {
        id,
        competition_key: "nfl",
        team_key: "dal",
        source_team_id: "permanent-team",
        owner_user_id: "owner",
        created_at: date
      }
    ],
    "app.sports_custom_sources": [
      {
        id,
        label: "Sports Daily",
        canonical_domain: "sports.example",
        owner_user_id: "owner",
        updated_at: date
      }
    ]
  };
  const queries: { table: string; wheres: unknown[][] }[] = [];
  const db = {
    [dataContextBrand]: true,
    db: {
      selectFrom(table: string) {
        const entry = { table, wheres: [] as unknown[][] };
        queries.push(entry);
        const query = {
          select: () => query,
          selectAll: () => query,
          where: (...args: unknown[]) => {
            entry.wheres.push(args);
            return query;
          },
          executeTakeFirst: async () =>
            rows[table.split(" as ")[0]!]?.find((row) =>
              entry.wheres.every(([column, operator, value]) => {
                if (typeof column !== "string" || (value !== null && typeof value === "object"))
                  return true;
                const key = column.split(".").at(-1)!;
                if (!(key in row)) return true;
                return operator === "!=" ? row[key] !== value : row[key] === value;
              })
            )
        };
        return query;
      }
    }
  } as unknown as DataContextDb;
  return { db, rows, queries };
}
const taskChanges = {
  title: longText,
  description: "Details",
  status: "todo",
  priority: 3,
  dueAt: "2026-10-09T17:00:00Z",
  doAt: null,
  listId: id,
  effort: "medium",
  parentTaskId: id,
  recurrence: { freq: "weekly", interval: 2, occurrence_date: "2026-10-09" }
};
const confirmSource = {
  confirmationId: "preview-key",
  authorizationAcknowledgement: "I authorize this publisher",
  canonicalDomain: "sports.example",
  confirmedFetchHosts: ["sports.example"],
  targets: [
    {
      target: { kind: "sport", sportKey: "football" },
      targetUrl: "https://sports.example/football"
    }
  ]
};
const toolInputs: Record<string, Record<string, unknown>> = {
  "briefings.rerun": { briefingType: "morning" },
  "tasks.create": taskChanges,
  "tasks.update": { taskId: id, ...taskChanges },
  "tasks.updateStatus": { taskId: id, status: "done" },
  "tasks.breakDown": { taskId: id, steps: ["First", longText] },
  "tasks.addActivity": { taskId: id, activityType: "comment", body: longText },
  "tasks.assignTag": { taskId: id, tagId: id },
  "tasks.unassignTag": { taskId: id, tagId: id },
  "tasks.createList": { name: "Work" },
  "tasks.renameList": { listId: id, name: "Career" },
  "tasks.deleteList": { listId: id, reassignToListId: second },
  "tasks.createTag": { listId: id, name: "Soon" },
  "tasks.renameTag": { listId: id, tagId: id, name: "Soon" },
  "tasks.deleteTag": { listId: id, tagId: id },
  "scratchpad.append": { text: longText },
  "workshop.buildModule": { description: longText, requestKey: id },
  "goals.create": {
    title: longText,
    desiredOutcome: "Ship well",
    priority: 3,
    reviewCadence: "weekly",
    targetAt: "2026-10-09T17:00:00Z"
  },
  "goals.update": {
    goalId: id,
    title: longText,
    desiredOutcome: "Ship well",
    status: "active",
    priority: 3,
    reviewCadence: "weekly",
    targetAt: "2026-10-09T17:00:00Z"
  },
  "goals.addEvidence": {
    goalId: id,
    evidenceKind: "progress",
    sourceKind: "goal",
    sourceRef: id,
    sourceLabel: "Goal",
    summary: longText,
    occurredAt: "2026-10-07T10:00:00Z"
  },
  "commitments.accept": { candidateId: id },
  "commitments.reject": { candidateId: id },
  "commitments.snooze": { candidateId: id, snoozedUntil: "2026-10-09T17:00:00Z" },
  "people.acceptMatch": { candidateId: id },
  "people.rejectMatch": { candidateId: id },
  "people.merge": { primaryPersonId: id, secondaryPersonId: second },
  "people.splitIdentity": {
    identityId: id,
    targetPersonId: second,
    newPersonDisplayName: "Jordan"
  },
  "sports.followTeam": { competitionKey: "nfl", teamKey: "dal" },
  "sports.unfollowTeam": { competitionKey: "nfl", teamKey: "dal" },
  "sports.confirmSource": confirmSource,
  "sports.confirmSourceAssignments": { sourceId: id, ...confirmSource },
  "sports.confirmSourceRecipe": { sourceId: id, ...confirmSource },
  "sports.retrySource": { sourceId: id },
  "sports.removeSource": { sourceId: id }
};

beforeEach(() => {
  vi.restoreAllMocks();
  configureGoalApprovalReferences(undefined);
  const definition = {
    id,
    title: "Morning outlook",
    owner_user_id: "owner",
    briefing_type: "morning",
    updated_at: date,
    selected_tool_names: ["tasks.list"]
  } as Awaited<ReturnType<BriefingsRepository["getOwnedDefinitionById"]>>;
  vi.spyOn(BriefingsRepository.prototype, "getOwnedDefinitionById").mockResolvedValue(definition);
  vi.spyOn(BriefingsRepository.prototype, "listDefinitions").mockResolvedValue([definition!]);
  state.teamId = "permanent-team";
  state.teamName = "Dallas Cowboys";
  state.previewOwner = "owner";
  state.previewKind = "new-source";
  vi.spyOn(GoalsRepository.prototype, "getById").mockResolvedValue({
    id,
    title: "Launch goal",
    updatedAt: date.toISOString()
  } as Awaited<ReturnType<GoalsRepository["getById"]>>);
  const registry = new FeedbackTargetVerifierRegistry();
  registry.register("chat_message", async (_db, input) => ({
    ...input,
    ownerUserId: input.actorUserId,
    canRemember: false,
    approvalTarget: { label: "Chat message: Ship on Friday", version: "message-version" }
  }));
  configureUsefulnessFeedbackPresentation(registry);
});

afterEach(() => {
  configureUsefulnessFeedbackPresentation(undefined);
  configureGoalApprovalReferences(undefined);
});

function visible(result: HumanActionDetails) {
  return JSON.stringify({ target: result.target, fields: result.fields });
}

describe("noncore approval catalog coverage", () => {
  it("requires every mutating tool to have an authored title, presenter, and full-schema fixture", () => {
    const tools = manifests
      .flatMap((manifest) => manifest.assistantTools ?? [])
      .filter((tool) => tool.risk !== "read");
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(toolInputs).sort());
    for (const tool of tools) {
      expect(tool.actionLabel, tool.name).toBeTruthy();
      expect(tool.approvalPresentation, tool.name).toBeTypeOf("function");
      expect(
        (tool.name === "briefings.rerun"
          ? ["briefingType", "definitionId"]
          : Object.keys(toolInputs[tool.name]!)
        ).sort(),
        tool.name
      ).toEqual(Object.keys((tool.inputSchema?.properties ?? {}) as object).sort());
    }
  });

  it("accounts for every callable mutating route, with only the pre-existing unavailable commitment resolution", () => {
    const missing = manifests
      .flatMap((manifest) => manifest.routes ?? [])
      .filter(
        (route) =>
          (route.chat?.access === "write" ||
            route.chat?.access === "destructive" ||
            route.chat?.outbound) &&
          !route.chat.presentation
      )
      .map((route) => `${route.method} ${route.path}`);
    expect(missing).toEqual(["POST /api/commitments/candidates/:id/resolve"]);
  });

  it("tasks declarations track every schema property, including references", () => {
    for (const [action, declaration] of Object.entries(taskApprovalActions)) {
      expect([...Object.keys(declaration.fields), ...declaration.refs].sort()).toEqual(
        Object.keys(toolInputs[`tasks.${action}`]!).sort()
      );
    }
  });
});

const tools = manifests
  .flatMap((manifest) => manifest.assistantTools ?? [])
  .filter((tool) => tool.risk !== "read");
describe.each(tools)("$name human disclosure", (tool) => {
  it("rejects undeclared input, even when it looks like an internal identifier", async () => {
    expect(
      await tool.approvalPresentation!(
        scoped().db,
        { ...toolInputs[tool.name], hiddenDestinationId: second },
        ctx
      )
    ).toBeNull();
  });
  it("discloses full valid values without exposing resource identifiers", async () => {
    if (tool.name === "sports.confirmSourceAssignments")
      state.previewKind = "assignment-replacement";
    if (tool.name === "sports.confirmSourceRecipe") state.previewKind = "recipe-rebuild";
    const result = await tool.approvalPresentation!(scoped().db, toolInputs[tool.name]!, ctx);
    expect(result, tool.name).not.toBeNull();
    expect(result!.target.trim()).not.toBe("");
    expect(visible(result!)).not.toContain(id);
    expect(visible(result!)).not.toContain(second);
    if (JSON.stringify(toolInputs[tool.name]).includes(longText.slice(0, 12)))
      expect(result!.fields.some((field) => field.value === longText)).toBe(true);
  });
});

type RouteFixture = {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  target?: string;
};
const checkin = {
  feelingCore: "happy",
  feelingSecondary: "Joy",
  feelingTertiary: "Content",
  sensations: ["Warm", "Relaxed"],
  intensity: 4,
  energy: 3,
  note: longText
};
const routeInputs: Record<string, RouteFixture> = {
  "GET /api/sports/leagues/:competitionKey/teams": { params: { competitionKey: "nfl" } },
  "GET /api/sports/standings": { query: { competitionKey: "nfl" } },
  "GET /api/sports/sources/:sourceId/icon": { params: { sourceId: id } },
  "DELETE /api/backtrack/segments": {
    body: { from: "2026-10-06T10:00:00Z", to: "2026-10-07T10:00:00Z" }
  },
  "POST /api/tasks/:id/activity": {
    params: { id },
    body: { activityType: "comment", body: longText }
  },
  "POST /api/tasks/:id/tags": { params: { id }, body: { tagId: id } },
  "DELETE /api/tasks/:id/tags/:tagId": {
    params: { id, tagId: id },
    target: "Important on Write launch plan"
  },
  "POST /api/tasks/lists": { body: { name: "Work" } },
  "PATCH /api/tasks/lists/:listId": { params: { listId: id }, body: { name: "Career" } },
  "DELETE /api/tasks/lists/:listId": {
    params: { listId: id },
    body: { reassignToListId: second },
    target: "Work"
  },
  "POST /api/tasks/lists/:listId/tags": { params: { listId: id }, body: { name: "Soon" } },
  "PATCH /api/tasks/lists/:listId/tags/:tagId": {
    params: { listId: id, tagId: id },
    body: { name: "Soon" }
  },
  "DELETE /api/tasks/lists/:listId/tags/:tagId": {
    params: { listId: id, tagId: id },
    target: "Important"
  },
  "POST /api/tasks/:id/breakdown": { params: { id }, body: { steps: [longText, "Finish"] } },
  "PATCH /api/tasks/preferences": { body: { defaultView: "matrix" } },
  "POST /api/scratchpad/append": { body: { text: longText } },
  "PATCH /api/scratchpad/settings": { body: { syncToNotes: true, shortcut: "Control+Shift+L" } },
  "PATCH /api/notifications/:id/read": { params: { id } },
  "PATCH /api/notifications/read-all": {},
  "DELETE /api/notifications/push/subscriptions/:id": {
    params: { id },
    target: "Personal browser"
  },
  "POST /api/wellness/checkins": { body: { ...checkin, identifiedVia: "wheel" } },
  "PATCH /api/wellness/checkins/:id": { params: { id }, body: checkin },
  "DELETE /api/wellness/therapy-notes/:id": {
    params: { id },
    target: "Therapy note from Wednesday"
  },
  "PATCH /api/workshop/projects/:projectId": {
    params: { projectId: id },
    body: { title: longText }
  },
  "DELETE /api/workshop/projects/:projectId": {
    params: { projectId: id },
    target: "Garden planner"
  },
  "POST /api/goals": { body: toolInputs["goals.create"] },
  "PATCH /api/commitments/candidates/:id/status": {
    params: { id },
    body: { status: "snoozed", snoozedUntil: "2026-10-09T17:00:00Z" }
  },
  "POST /api/commitments/candidates/:id/suppress": { params: { id }, body: { suppressedBy: id } },
  "POST /api/people/match-candidates/:id/accept": { params: { id } },
  "POST /api/people/match-candidates/:id/reject": { params: { id } },
  "POST /api/people/match-candidates/:id/suppress": { params: { id } },
  "PUT /api/sports/standings-preferences": {
    body: {
      selectedCompetitionKeys: ["nfl", "nba"],
      lastViewed: { competitionKey: "nfl", viewKey: "sec:0", viewLabel: "East" }
    }
  },
  "POST /api/sports/follows": { body: { competitionKey: "nfl", teamKey: "dal" } },
  "POST /api/sports/follows/:id/team": { params: { id }, body: { sourceTeamId: "permanent-team" } },
  "DELETE /api/sports/follows/:id": { params: { id }, target: "Dallas Cowboys (NFL)" },
  "PUT /api/sports/sources/espn/coverage": {
    body: {
      assignments: [
        { kind: "sport", sportKey: "football" },
        { kind: "follow", followId: id }
      ]
    }
  },
  "DELETE /api/sports/sources/:id": { params: { id }, target: "Sports Daily (sports.example)" },
  "DELETE /api/sports/sources/:id/photos": {
    params: { id },
    target: "Sports Daily (sports.example)"
  },
  "POST /api/me/usefulness-feedback/signals": {
    body: { targetKind: "chat_message", targetRef: id, surface: "chat", kind: "not_useful" }
  }
};
const routes = manifests
  .flatMap((manifest) => manifest.routes ?? [])
  .filter((route) => route.chat?.presentation);
it("keeps positive route fixtures complete as the callable catalog grows", () => {
  expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
    Object.keys(routeInputs).sort()
  );
});
describe.each(routes)("$method $path exact route disclosure", (route) => {
  const fixture = routeInputs[`${route.method} ${route.path}`]!;
  const input = () => ({ params: {}, target: null, ...fixture });
  it("renders readable complete fields and no raw identifiers", async () => {
    const result = await route.chat!.presentation!(scoped().db, input(), ctx);
    expect(result).not.toBeNull();
    expect(visible(result!)).not.toContain(id);
    expect(visible(result!)).not.toContain(second);
    const properties = (route.requestSchema as { properties?: object } | undefined)?.properties;
    if (properties)
      expect(Object.keys(fixture.body ?? {}).sort()).toEqual(Object.keys(properties).sort());
  });
  it("rejects every unaccounted body, query and parameter field", async () => {
    const present = route.chat!.presentation!;
    const body = { ...(fixture.body as object | undefined), hiddenDestinationId: second };
    await expect(
      Promise.resolve()
        .then(() => present(scoped().db, { ...input(), body }, ctx))
        .catch(() => null)
    ).resolves.toBeNull();
    expect(await present(scoped().db, { ...input(), query: { hidden: "extra" } }, ctx)).toBeNull();
    expect(
      await present(scoped().db, { ...input(), params: { ...input().params, extra: second } }, ctx)
    ).toBeNull();
  });
});

it("does not trust a caller's People name when either owner-scoped merge target is absent", async () => {
  const { db, rows } = scoped();
  rows["app.person_context_people"] = [];
  const tool = tools.find((tool) => tool.name === "people.merge")!;
  expect(await tool.approvalPresentation!(db, toolInputs[tool.name]!, ctx)).toBeNull();
});
it("does not approve task moves to an invisible list or a tag belonging to a different list", async () => {
  const { db, rows } = scoped();
  rows["app.task_lists"] = [{ id, name: "Work" }];
  const remove = tools.find((tool) => tool.name === "tasks.deleteList")!;
  expect(await remove.approvalPresentation!(db, toolInputs[remove.name]!, ctx)).toBeNull();
  rows["app.task_tags"] = [{ id, name: "Important", list_id: second }];
  const tag = tools.find((tool) => tool.name === "tasks.renameTag")!;
  expect(await tag.approvalPresentation!(db, toolInputs[tag.name]!, ctx)).toBeNull();
});
it("binds unchanged labels to permanent provider identity and rejects missing sports identity", async () => {
  const tool = tools.find((tool) => tool.name === "sports.followTeam")!;
  const first = await tool.approvalPresentation!(scoped().db, toolInputs[tool.name]!, ctx);
  state.teamId = "new-permanent-team";
  const secondResult = await tool.approvalPresentation!(scoped().db, toolInputs[tool.name]!, ctx);
  expect(first?.target).toBe(secondResult?.target);
  expect(first?.version).not.toBe(secondResult?.version);
  state.teamId = "";
  expect(await tool.approvalPresentation!(scoped().db, toolInputs[tool.name]!, ctx)).toBeNull();
});
it("rejects foreign or substituted sports previews and nested hidden authority", async () => {
  const tool = tools.find((tool) => tool.name === "sports.confirmSource")!;
  state.previewOwner = "other-owner";
  expect(await tool.approvalPresentation!(scoped().db, confirmSource, ctx)).toBeNull();
  state.previewOwner = "owner";
  expect(
    await tool.approvalPresentation!(
      scoped().db,
      { ...confirmSource, confirmedFetchHosts: ["other.example"] },
      ctx
    )
  ).toBeNull();
  expect(
    await tool.approvalPresentation!(
      scoped().db,
      { ...confirmSource, targets: [{ ...confirmSource.targets[0], hiddenId: second }] },
      ctx
    )
  ).toBeNull();
  expect(
    await tool.approvalPresentation!(
      scoped().db,
      {
        ...confirmSource,
        targets: [
          {
            target: { kind: "sport", sportKey: "football", followId: id },
            targetUrl: "https://sports.example/football"
          }
        ]
      },
      ctx
    )
  ).toBeNull();
});
it("does not turn a foreign goal evidence reference into a label supplied by the caller", async () => {
  const tool = tools.find((tool) => tool.name === "goals.addEvidence")!;
  expect(
    await tool.approvalPresentation!(
      scoped().db,
      { ...toolInputs[tool.name], sourceKind: "email", sourceLabel: "Trust me", sourceRef: id },
      ctx
    )
  ).toBeNull();
});
it("requires an owning-module feedback target label in addition to ownership verification", async () => {
  const registry = new FeedbackTargetVerifierRegistry();
  registry.register("chat_message", async (_db, input) => ({
    ...input,
    ownerUserId: input.actorUserId,
    sourceLabel: "Chat",
    canRemember: false
  }));
  configureUsefulnessFeedbackPresentation(registry);
  const route = routes.find((route) => route.path === "/api/me/usefulness-feedback/signals")!;
  expect(
    await route.chat!.presentation!(
      scoped().db,
      { params: {}, target: null, body: routeInputs[`POST ${route.path}`]!.body },
      ctx
    )
  ).toBeNull();
});
it("rejects unknown nested recurrence fields rather than truncating disclosure", async () => {
  const tool = tools.find((tool) => tool.name === "tasks.create")!;
  expect(
    await tool.approvalPresentation!(
      scoped().db,
      { ...taskChanges, recurrence: { ...taskChanges.recurrence, hiddenEndDate: "2030-01-01" } },
      ctx
    )
  ).toBeNull();
});

it("briefing choices resolve through the same owned definition reader as execution", async () => {
  const tool = tools.find((tool) => tool.name === "briefings.rerun")!;
  const byType = await tool.approvalPresentation!(scoped().db, { briefingType: "morning" }, ctx);
  const byId = await tool.approvalPresentation!(scoped().db, { definitionId: id }, ctx);
  expect(byId?.target).toBe("Morning outlook");
  expect(byId?.version).toBe(byType?.version);
  expect(
    await tool.approvalPresentation!(
      scoped().db,
      { definitionId: id, briefingType: "morning" },
      ctx
    )
  ).toBeNull();
  expect(await tool.approvalPresentation!(scoped().db, {}, ctx)).toBeNull();
  vi.mocked(BriefingsRepository.prototype.getOwnedDefinitionById).mockResolvedValue(undefined);
  expect(await tool.approvalPresentation!(scoped().db, { definitionId: id }, ctx)).toBeNull();
  vi.mocked(BriefingsRepository.prototype.listDefinitions).mockResolvedValue([]);
  expect(
    await tool.approvalPresentation!(scoped().db, { briefingType: "morning" }, ctx)
  ).toBeNull();
});
it("Backtrack discloses permanent everything deletion and rejects partial or excessive ranges", async () => {
  const route = routes.find((route) => route.path === "/api/backtrack/segments")!;
  const present = route.chat!.presentation!;
  for (const body of [undefined, null, {}]) {
    const result = await present(scoped().db, { params: {}, target: null, body }, ctx);
    expect(result?.target).toBe("All your stored Backtrack history");
    expect(result?.fields.some((field) => field.value.includes("cannot be undone"))).toBe(true);
  }
  for (const body of [
    { from: "2026-10-01" },
    { from: "2026-01-01", to: "2026-10-07" },
    { from: "2026-10-08", to: "2026-10-07" },
    { from: "not a date", to: "2026-10-07" }
  ])
    expect(await present(scoped().db, { params: {}, target: null, body }, ctx)).toBeNull();
});
it("sports preview inspection neither consumes nor extends actor-bound expiry", () => {
  let now = 100;
  const store = createSportsPreviewStore({ now: () => now, ttlMs: 10 });
  const preview: PendingSportsSourcePreview = {
    kind: "new-source",
    ownerUserId: "owner",
    authorizationAcknowledgement: "I authorize this publisher",
    createdAt: now,
    submittedUrl: "https://sports.example",
    duplicateOfSourceId: null,
    candidate: {
      candidateId: "candidate",
      label: "Sports Daily",
      canonicalDomain: "sports.example",
      homepageUrl: "https://sports.example",
      sampleCount: 0,
      validationFingerprint: "fingerprint",
      confirmedFetchHosts: ["sports.example"],
      targets: [],
      checkedAt: date.toISOString(),
      samples: [],
      feedUrl: "https://sports.example/feed",
      retrievalMethod: "feed",
      recipe: null,
      recipeFingerprint: null
    }
  };
  const token = store.put(preview);
  expect(store.peek("other-owner", token)).toBeNull();
  expect(store.peek("owner", token)).toEqual(preview);
  expect(store.peek("owner", token)).toEqual(preview);
  expect(store.take("owner", token)).toEqual(preview);
  expect(store.peek("owner", token)).toBeNull();
  const expired = store.put(preview);
  now = 111;
  expect(store.peek("owner", expired)).toBeNull();
  expect(store.take("owner", expired)).toBeNull();
});
it("sports authority comparison accepts object key order without accepting extra target keys", async () => {
  const tool = tools.find((tool) => tool.name === "sports.confirmSource")!;
  const result = await tool.approvalPresentation!(
    scoped().db,
    {
      ...confirmSource,
      targets: [
        {
          target: { sportKey: "football", kind: "sport" },
          targetUrl: "https://sports.example/football"
        }
      ]
    },
    ctx
  );
  expect(result?.target).toBe("Sports Daily");
});
it("foreign goal references use the configured public owner-scoped reader and bind its version", async () => {
  const reader = vi.fn(async () => ({
    label: "Contract approval email",
    version: "email-version-1"
  }));
  configureGoalApprovalReferences(reader);
  const { db } = scoped();
  const tool = tools.find((tool) => tool.name === "goals.addEvidence")!;
  const input = {
    ...toolInputs[tool.name],
    sourceKind: "email",
    sourceRef: second,
    sourceLabel: "User-written context"
  };
  const result = await tool.approvalPresentation!(db, input, ctx);
  expect(reader).toHaveBeenCalledWith(db, {
    actorUserId: "owner",
    sourceKind: "email",
    sourceRef: second
  });
  expect(result?.fields).toContainEqual({ label: "Source", value: "Contract approval email" });
  expect(result?.fields).toContainEqual({ label: "Source label", value: "User-written context" });
  reader.mockResolvedValue({ label: "Contract approval email", version: "email-version-2" });
  const changed = await tool.approvalPresentation!(db, input, ctx);
  expect(changed?.version).not.toBe(result?.version);
});
it("input-only drafts do not claim to have read outside content; resolved targets keep provenance", async () => {
  const task = tools.find((tool) => tool.name === "tasks.create")!;
  expect(
    (await task.approvalPresentation!(scoped().db, { title: "Write a plan" }, ctx))?.content
  ).toBe("user_authored");
  expect(
    (await task.approvalPresentation!(scoped().db, { title: "Write a plan", listId: id }, ctx))
      ?.content
  ).toBe("outside");
  for (const name of ["goals.create", "scratchpad.append", "workshop.buildModule"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    expect(
      (await tool.approvalPresentation!(scoped().db, toolInputs[name]!, ctx))?.content,
      name
    ).toBe("user_authored");
  }
  const sports = tools.find((tool) => tool.name === "sports.followTeam")!;
  expect(
    (await sports.approvalPresentation!(scoped().db, { competitionKey: "nfl" }, ctx))?.content
  ).toBe("user_authored");
  expect(
    (
      await sports.approvalPresentation!(
        scoped().db,
        { competitionKey: "nfl", teamKey: "dal" },
        ctx
      )
    )?.content
  ).toBe("outside");
});
