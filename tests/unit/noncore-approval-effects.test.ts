import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { HumanActionDetails, MossModuleManifest, ToolContext } from "@moss/module-sdk";
import type * as SportsChatTools from "../../packages/sports/src/chat-tools.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";
import { peopleModuleManifest } from "../../packages/people/src/manifest.js";
import { backtrackModuleManifest } from "../../packages/backtrack/src/manifest.js";

const previewState = vi.hoisted(() => ({ empty: false }));
vi.mock("../../packages/sports/src/chat-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SportsChatTools>()),
  sportsApprovalPreview: (ownerUserId: string) => ({
    kind: "assignment-replacement",
    sourceId: "11111111-1111-4111-8111-111111111111",
    ownerUserId,
    authorizationAcknowledgement: "I authorize this publisher",
    candidate: {
      label: "Sports Daily",
      canonicalDomain: "sports.example",
      confirmedFetchHosts: ["sports.example"],
      targets: previewState.empty
        ? []
        : [
            {
              target: { kind: "sport", sportKey: "football" },
              targetUrl: "https://sports.example/football"
            }
          ]
    }
  }),
  sportsApprovalTeams: async () => ({
    teams: [{ teamKey: "dal", name: "Dallas Cowboys", sourceTeamId: "provider-team" }],
    degraded: false
  })
}));
const id = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const ctx = { actorUserId: "owner", requestId: "request", chatSessionId: "chat" } as ToolContext;
const now = new Date("2026-10-07T12:00:00Z");
function scoped() {
  const rows: Record<string, Record<string, unknown>[]> = {
    "app.tasks": [{ id, title: "Write launch plan", updated_at: now }],
    "app.task_lists": [
      { id, name: "Work" },
      { id: destination, name: "Personal" }
    ],
    "app.task_tags": [{ id, name: "Important", list_id: id }],
    "app.sports_follows": [
      {
        id,
        competition_key: "nfl",
        team_key: "dal",
        source_team_id: "provider-team",
        owner_user_id: "owner",
        created_at: now
      }
    ],
    "app.sports_custom_sources": [
      {
        id,
        label: "Sports Daily",
        canonical_domain: "sports.example",
        owner_user_id: "owner",
        updated_at: now
      }
    ],
    "app.person_context_identities": [
      {
        id,
        display_value: "alex@example.com",
        person_id: id,
        owner_user_id: "owner",
        updated_at: now
      }
    ],
    "app.person_context_people": [
      { id, display_name: "Alex", owner_user_id: "owner", status: "active", updated_at: now },
      {
        id: destination,
        display_name: "Jordan",
        owner_user_id: "owner",
        status: "active",
        updated_at: now
      }
    ]
  };
  const db = {
    [dataContextBrand]: true,
    db: {
      selectFrom(table: string) {
        const wheres: unknown[][] = [];
        const query = {
          select: () => query,
          where: (...args: unknown[]) => {
            wheres.push(args);
            return query;
          },
          limit: () => query,
          execute: async () =>
            rows[table]?.filter((row) =>
              wheres.every(
                ([key, operator, value]) =>
                  typeof key !== "string" ||
                  (operator === "!=" ? row[key] !== value : row[key] === value)
              )
            ),
          executeTakeFirst: async () =>
            rows[table]?.find((row) =>
              wheres.every(
                ([key, operator, value]) =>
                  typeof key !== "string" ||
                  (operator === "!=" ? row[key] !== value : row[key] === value)
              )
            )
        };
        return query;
      }
    }
  } as unknown as DataContextDb;
  return { db, rows };
}
function tool(manifest: MossModuleManifest, name: string) {
  return manifest.assistantTools!.find((item) => item.name === name)!.approvalPresentation!;
}
function route(manifest: MossModuleManifest, method: string, path: string) {
  return manifest.routes!.find((item) => item.method === method && item.path === path)!.chat!
    .presentation!;
}
function field(result: HumanActionDetails | null, label: string) {
  expect(result).not.toBeNull();
  return result!.fields.find((item) => item.label === label)?.value;
}
const sourceEffect = "Remove this sports news source and all its coverage assignments.";
const photoEffect =
  "Delete stored photos for this source. Any copies left after a cleanup failure are removed during later cleanup.";
describe("saved Sports unfollow identity", () => {
  it("binds the current owner follow, including replacement and missing-to-created transitions", async () => {
    const { db, rows } = scoped();
    const present = tool(sportsModuleManifest, "sports.unfollowTeam");
    const input = { competitionKey: "nfl", teamKey: "dal" };
    const first = await present(db, input, ctx);
    rows["app.sports_follows"]![0]!.id = destination;
    const replacement = await present(db, input, ctx);
    expect(first?.version).not.toBe(replacement?.version);
    rows["app.sports_follows"] = [];
    const absent = await present(db, input, ctx);
    expect(absent).not.toBeNull();
    expect(absent?.version).not.toBe(replacement?.version);
    rows["app.sports_follows"] = [
      {
        id: "private-foreign-id",
        competition_key: "nfl",
        team_key: "dal",
        source_team_id: "provider-team",
        owner_user_id: "someone-else",
        created_at: now
      }
    ];
    expect(await present(db, input, ctx)).toEqual(absent);
  });
});

const followEffect =
  "Stop following this team or competition and remove its custom-source and ESPN headline coverage assignments.";

describe("reviewed sports removal and replacement effects", () => {
  it.each(["tool", "route"])(
    "source removal discloses source, coverage and stored-photo loss through %s",
    async (surface) => {
      const result =
        surface === "tool"
          ? await tool(sportsModuleManifest, "sports.removeSource")(
              scoped().db,
              { sourceId: id },
              ctx
            )
          : await route(sportsModuleManifest, "DELETE", "/api/sports/sources/:id")(
              scoped().db,
              { params: { id }, target: "Sports Daily" },
              ctx
            );
      expect(field(result, "Source and coverage")).toBe(sourceEffect);
      expect(field(result, "Stored photos")).toBe(photoEffect);
    }
  );
  it.each(["tool", "route"])(
    "unfollow discloses both coverage cascades and the last-ESPN-assignment fallback through %s",
    async (surface) => {
      const result =
        surface === "tool"
          ? await tool(sportsModuleManifest, "sports.unfollowTeam")(
              scoped().db,
              { competitionKey: "nfl", teamKey: "dal" },
              ctx
            )
          : await route(sportsModuleManifest, "DELETE", "/api/sports/follows/:id")(
              scoped().db,
              { params: { id }, target: "Dallas Cowboys" },
              ctx
            );
      expect(field(result, "Follow and coverage")).toBe(followEffect);
      expect(field(result, "ESPN fallback")).toBe(
        "If this removes the last ESPN coverage assignment while headlines are enabled, ESPN returns to its default coverage."
      );
    }
  );
  it("ESPN's nonempty assignment list is explicitly a full replacement that enables headlines", async () => {
    const result = await route(sportsModuleManifest, "PUT", "/api/sports/sources/espn/coverage")(
      scoped().db,
      {
        params: {},
        target: null,
        body: { assignments: [{ kind: "sport", sportKey: "football" }] }
      },
      ctx
    );
    expect(field(result, "Effect")).toBe(
      "Replace all current ESPN headline coverage assignments with the complete list below. Any assignment not listed will be removed."
    );
    expect(field(result, "ESPN headlines")).toBe("Turn on");
    expect(field(result, "New coverage 1")).toBe("Football");
  });
  it("ESPN's empty list explicitly removes all coverage and turns headlines off", async () => {
    const result = await route(sportsModuleManifest, "PUT", "/api/sports/sources/espn/coverage")(
      scoped().db,
      { params: {}, target: null, body: { assignments: [] } },
      ctx
    );
    expect(field(result, "Effect")).toBe(
      "Remove all ESPN headline coverage assignments and turn ESPN headlines off."
    );
    expect(field(result, "ESPN headlines")).toBe("Turn off");
    expect(field(result, "New coverage")).toBe("None");
  });
  it("forgetting photo instructions does not inherit the source-removal disclosure", async () => {
    const result = await route(sportsModuleManifest, "DELETE", "/api/sports/sources/:id/photos")(
      scoped().db,
      { params: { id }, target: "Sports Daily" },
      ctx
    );
    expect(field(result, "Effect")).toBe(
      "Forget Moss's saved photo-finding instructions for this source. Use photos already provided by the publisher's feed and article pages."
    );
    expect(
      result!.fields.some((item) => item.value === sourceEffect || item.value === photoEffect)
    ).toBe(false);
  });
});

describe("reviewed task list and tag effects", () => {
  it.each(["tool", "route"])(
    "list deletion with reassignment keeps tasks but deletes old-list tags through %s",
    async (surface) => {
      const result =
        surface === "tool"
          ? await tool(tasksModuleManifest, "tasks.deleteList")(
              scoped().db,
              { listId: id, reassignToListId: destination },
              ctx
            )
          : await route(tasksModuleManifest, "DELETE", "/api/tasks/lists/:listId")(
              scoped().db,
              { params: { listId: id }, target: "Work", body: { reassignToListId: destination } },
              ctx
            );
      expect(field(result, "Tasks")).toBe(
        "Move all tasks to the selected destination list; the tasks are kept."
      );
      expect(field(result, "Tags")).toBe(
        "Delete every tag in this list and remove their assignments from tasks."
      );
      expect(field(result, "Move tasks to list")).toBe("Personal");
    }
  );
  it("empty-list deletion explains the no-task-deletion guard and its tag loss", async () => {
    const result = await tool(tasksModuleManifest, "tasks.deleteList")(
      scoped().db,
      { listId: id },
      ctx
    );
    expect(field(result, "Tasks")).toBe(
      "Only an empty list can be deleted. A list that still contains tasks is left unchanged."
    );
    expect(field(result, "Tags")).toBe(
      "Delete every tag in this list and remove their assignments from tasks."
    );
  });
  it("tag deletion discloses assignments removed from all tasks", async () => {
    const result = await tool(tasksModuleManifest, "tasks.deleteTag")(
      scoped().db,
      { listId: id, tagId: id },
      ctx
    );
    expect(field(result, "Effect")).toBe(
      "Delete this tag and remove it from every task. The tasks are kept."
    );
  });
  it("moving a task discloses removal of tags that do not belong to its new list", async () => {
    const result = await tool(tasksModuleManifest, "tasks.update")(
      scoped().db,
      { taskId: id, listId: destination },
      ctx
    );
    expect(field(result, "Tags")).toBe(
      "Remove this task's tag assignments that do not belong to the selected destination list."
    );
  });
});

describe("reviewed People split precedence", () => {
  it("requires an explicit destination when two owner people share the requested name", async () => {
    const { db, rows } = scoped();
    rows["app.person_context_people"]!.push({
      id: "33333333-3333-4333-8333-333333333333",
      display_name: "Jordan",
      owner_user_id: "owner",
      status: "active",
      updated_at: now
    });
    await expect(
      tool(peopleModuleManifest, "people.splitIdentity")(
        db,
        { identityId: id, newPersonDisplayName: "Jordan" },
        ctx
      )
    ).rejects.toThrow(
      "More than one person has this name. Choose the specific existing person before moving the identity."
    );
    expect(
      await tool(peopleModuleManifest, "people.splitIdentity")(
        db,
        { identityId: id, targetPersonId: destination, newPersonDisplayName: "Jordan" },
        ctx
      )
    ).not.toBeNull();
  });

  it("shows the existing destination as effective and the submitted new-person name as unused", async () => {
    const result = await tool(peopleModuleManifest, "people.splitIdentity")(
      scoped().db,
      { identityId: id, targetPersonId: destination, newPersonDisplayName: "Unused name" },
      ctx
    );
    expect(field(result, "Move to")).toBe("Jordan");
    expect(field(result, "Unused name (existing person selected)")).toBe("Unused name");
    expect(
      result!.fields.some(
        (item) => item.label === "Name for a new person" || item.label === "Create person named"
      )
    ).toBe(false);
    expect(field(result, "Effect")).toBe(
      "Move this identity to the selected existing person. The supplied new-person name is unused; no person is created or renamed. This cannot be undone."
    );
  });
  it("a name matching an existing person is described as a reuse, not a creation", async () => {
    const result = await tool(peopleModuleManifest, "people.splitIdentity")(
      scoped().db,
      { identityId: id, newPersonDisplayName: "Jordan" },
      ctx
    );
    expect(field(result, "Move to existing person")).toBe("Jordan");
    expect(field(result, "Effect")).toBe(
      "Move this identity to the existing person with this exact name. No person is created. This cannot be undone."
    );
  });
  it("a new name is described as an actual person creation and move", async () => {
    const result = await tool(peopleModuleManifest, "people.splitIdentity")(
      scoped().db,
      { identityId: id, newPersonDisplayName: "New person" },
      ctx
    );
    expect(field(result, "Create person named")).toBe("New person");
    expect(field(result, "Effect")).toBe(
      "Create a person with this name and move this identity to that person. This cannot be undone."
    );
  });
});

it("Backtrack's authored heading distinguishes everything from a selected range", async () => {
  const present = route(backtrackModuleManifest, "DELETE", "/api/backtrack/segments");
  for (const body of [undefined, null, {}]) {
    const result = await present(scoped().db, { params: {}, target: null, body }, ctx);
    expect((result as HumanActionDetails & { title?: string })?.title).toBe(
      "Delete all your Backtrack history"
    );
  }
  const result = await present(
    scoped().db,
    {
      params: {},
      target: null,
      body: { from: "2026-10-06T12:00:00Z", to: "2026-10-07T12:00:00Z" }
    },
    ctx
  );
  expect((result as HumanActionDetails & { title?: string })?.title).toBe(
    "Delete Backtrack history in a time range"
  );
});

it.each([false, true])(
  "custom source coverage confirmation discloses complete replacement (empty=%s)",
  async (empty) => {
    previewState.empty = empty;
    const result = await tool(sportsModuleManifest, "sports.confirmSourceAssignments")(
      scoped().db,
      {
        sourceId: id,
        confirmationId: "preview",
        authorizationAcknowledgement: "I authorize this publisher",
        canonicalDomain: "sports.example",
        confirmedFetchHosts: ["sports.example"],
        targets: empty
          ? []
          : [
              {
                target: { kind: "sport", sportKey: "football" },
                targetUrl: "https://sports.example/football"
              }
            ]
      },
      ctx
    );
    expect(field(result, "Effect")).toBe(
      empty
        ? "Remove all coverage assignments for this source."
        : "Replace all coverage assignments for this source with the complete list shown. Any assignment not listed will be removed."
    );
  }
);
it("task tag DELETE route carries the same all-task assignment loss as the dedicated tool", async () => {
  const result = await route(tasksModuleManifest, "DELETE", "/api/tasks/lists/:listId/tags/:tagId")(
    scoped().db,
    { params: { listId: id, tagId: id }, target: "Important" },
    ctx
  );
  expect(field(result, "Effect")).toBe(
    "Delete this tag and remove it from every task. The tasks are kept."
  );
});
it("an existing People destination without a second name does not claim an unused field", async () => {
  const result = await tool(peopleModuleManifest, "people.splitIdentity")(
    scoped().db,
    { identityId: id, targetPersonId: destination },
    ctx
  );
  expect(field(result, "Move to")).toBe("Jordan");
  expect(field(result, "Effect")).toBe(
    "Move this identity to the selected existing person. No person is created or renamed. This cannot be undone."
  );
  expect(result!.fields.some((item) => item.label.startsWith("Unused name"))).toBe(false);
});
it("People's omitted destination and name disclose the identity label used to create a person", async () => {
  const result = await tool(peopleModuleManifest, "people.splitIdentity")(
    scoped().db,
    { identityId: id },
    ctx
  );
  expect(field(result, "Create person named")).toBe("alex@example.com");
  expect(field(result, "Effect")).toBe(
    "Create a person with this name and move this identity to that person. This cannot be undone."
  );
});
