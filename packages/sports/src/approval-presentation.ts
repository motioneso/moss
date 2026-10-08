import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import {
  approvalChoice,
  approvalText,
  presentApprovalFields,
  type ApprovalField,
  type ApprovalFieldMap,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import {
  sportsApprovalPreview,
  sportsApprovalStandings,
  sportsApprovalTeams
} from "./chat-tools.js";
import { catalogEntry } from "./source/catalog.js";
import { SPORTS_SPORT_LABELS } from "./source/scope.js";
import { buildViews } from "./standings-views.js";

// These describe the existing repository cascades and service cleanup, not extra operations.
const removalEffects = {
  source: [
    {
      label: "Source and coverage",
      value: "Remove this sports news source and all its coverage assignments."
    },
    {
      label: "Stored photos",
      value:
        "Delete stored photos for this source. Any copies left after a cleanup failure are removed during later cleanup."
    }
  ],
  follow: [
    {
      label: "Follow and coverage",
      value:
        "Stop following this team or competition and remove its custom-source and ESPN headline coverage assignments."
    },
    {
      label: "ESPN fallback",
      value:
        "If this removes the last ESPN coverage assignment while headlines are enabled, ESPN returns to its default coverage."
    }
  ],
  "photo-instructions": [
    {
      label: "Effect",
      value:
        "Forget Moss's saved photo-finding instructions for this source. Use photos already provided by the publisher's feed and article pages."
    }
  ]
} as const;

type Resolved = { label: string; version: unknown; sourceTeamId?: string };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const competitionLabel = (value: unknown) =>
  typeof value === "string" ? (catalogEntry(value)?.label ?? null) : null;
async function teamLabel(
  competition: string,
  key: string,
  permanent: boolean
): Promise<Resolved | null> {
  const { teams } = await sportsApprovalTeams(competition);
  const matches = teams.filter((team) =>
    permanent ? team.sourceTeamId === key : team.teamKey === key
  );
  const team = matches.length === 1 ? matches[0] : undefined;
  return team?.sourceTeamId
    ? {
        label: team.name,
        version: [competition, team.sourceTeamId, team.name],
        sourceTeamId: team.sourceTeamId
      }
    : null;
}
async function followLabel(
  db: DataContextDb,
  owner: string,
  id: unknown
): Promise<Resolved | null> {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.sports_follows")
    .select(["id", "competition_key", "team_key", "source_team_id", "created_at"])
    .where("id", "=", id)
    .where("owner_user_id", "=", owner)
    .executeTakeFirst();
  if (!row) return null;
  const competition = competitionLabel(row.competition_key);
  if (!competition) return null;
  if (row.team_key === null) return { label: competition, version: row };
  if (!row.source_team_id) return null;
  const team = await teamLabel(row.competition_key, row.source_team_id, true);
  return team ? { label: `${team.label} (${competition})`, version: [row, team.version] } : null;
}
async function sourceLabel(
  db: DataContextDb,
  owner: string,
  id: unknown
): Promise<Resolved | null> {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.sports_custom_sources")
    .select(["id", "label", "canonical_domain", "updated_at"])
    .where("id", "=", id)
    .where("owner_user_id", "=", owner)
    .executeTakeFirst();
  return row ? { label: `${row.label} (${row.canonical_domain})`, version: row } : null;
}
async function assignmentLabel(
  db: DataContextDb,
  owner: string,
  value: unknown
): Promise<Resolved | null> {
  const target = object(value);
  if (!target) return null;
  if (target.kind === "sport") {
    const fields = presentApprovalFields(
      target,
      {
        kind: { label: "Scope", present: approvalChoice({ sport: "Sport" }) },
        sportKey: { label: "Sport", present: approvalChoice(SPORTS_SPORT_LABELS) }
      },
      ["kind", "sportKey"]
    );
    return fields
      ? { label: fields.find((field) => field.label === "Sport")!.value, version: target }
      : null;
  }
  if (
    target.kind !== "follow" ||
    Object.keys(target).length !== 2 ||
    !Object.hasOwn(target, "followId")
  )
    return null;
  return followLabel(db, owner, target.followId);
}

async function followDisclosure(input: Record<string, unknown>) {
  const competition = competitionLabel(input.competitionKey);
  if (!competition || typeof input.competitionKey !== "string") return null;
  const team =
    typeof input.teamKey === "string"
      ? await teamLabel(input.competitionKey, input.teamKey, false)
      : null;
  if (input.teamKey != null && !team) return null;
  const fields = presentApprovalFields(
    input,
    {
      competitionKey: {
        label: "Competition",
        present: (value) => (value === input.competitionKey ? competition : null)
      },
      teamKey: {
        label: "Team",
        present: (value) =>
          value === null ? "Whole competition" : value === input.teamKey && team ? team.label : null
      }
    },
    ["competitionKey"]
  );
  return fields
    ? {
        sourceTeamId: team?.sourceTeamId,
        details: {
          content: team ? ("outside" as const) : ("user_authored" as const),
          target: team ? `${team.label} (${competition})` : competition,
          fields,
          version: JSON.stringify([input.competitionKey, team?.version ?? null])
        }
      }
    : null;
}
export const sportsFollowPresentation: ToolApprovalPresentation = async (_db, input) =>
  (await followDisclosure(input))?.details ?? null;
export const sportsUnfollowPresentation: ToolApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  const disclosure = await followDisclosure(input);
  if (!disclosure || typeof input.competitionKey !== "string") return null;
  const { details, sourceTeamId } = disclosure;
  // The tool executes by catalog key, but consent belongs to this exact saved follow.
  // Bind absence too: a follow created while the card waits must require a fresh decision.
  let query = db.db
    .selectFrom("app.sports_follows")
    .select(["id", "competition_key", "team_key", "source_team_id", "created_at"])
    .where("owner_user_id", "=", ctx.actorUserId)
    .where("competition_key", "=", input.competitionKey);
  if (input.teamKey == null) query = query.where("team_key", "is", null);
  else {
    if (!sourceTeamId) return null;
    query = query.where("source_team_id", "=", sourceTeamId);
  }
  const saved = (await query.executeTakeFirst()) ?? null;
  return {
    ...details,
    fields: [
      ...details.fields,
      ...(saved
        ? removalEffects.follow
        : [
            {
              label: "Effect",
              value:
                "This team or competition is not currently followed; no saved follow or coverage will be removed."
            }
          ])
    ],
    version: JSON.stringify([details.version, saved])
  };
};

export const sportsFollowRoutePresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const body = object(input.body);
  return body ? sportsFollowPresentation(db, body, ctx) : null;
};

export const sportsResolveTeamPresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  if (
    Object.keys(input.params).length !== 1 ||
    !input.params.id ||
    !isUuid(input.params.id) ||
    (input.query && Object.keys(input.query).length)
  )
    return null;
  const body = object(input.body);
  if (!body || Object.keys(body).length !== 1 || typeof body.sourceTeamId !== "string") return null;
  const row = await db.db
    .selectFrom("app.sports_follows")
    .select(["id", "competition_key", "team_key", "source_team_id", "created_at"])
    .where("id", "=", input.params.id)
    .where("owner_user_id", "=", ctx.actorUserId)
    .executeTakeFirst();
  if (!row || row.team_key === null) return null;
  const competition = competitionLabel(row.competition_key);
  const team = await teamLabel(row.competition_key, body.sourceTeamId, true);
  if (!competition || !team) return null;
  // An unresolved legacy follow has no trustworthy full team name; identify its saved label.
  return {
    target: `Saved team choice in ${competition}`,
    fields: [
      { label: "Saved on", value: row.created_at.toISOString() },
      { label: "Selected team", value: team.label }
    ],
    version: JSON.stringify([row, team.version])
  };
};

export function sportsRemovalPresentation(
  kind: keyof typeof removalEffects
): RouteApprovalPresentation {
  return async (db, input, ctx) => {
    assertDataContextDb(db);
    if (
      Object.keys(input.params).length !== 1 ||
      (input.query && Object.keys(input.query).length) ||
      !presentApprovalFields(input.body, {})
    )
      return null;
    const target = await (kind === "follow" ? followLabel : sourceLabel)(
      db,
      ctx.actorUserId,
      input.params.id
    );
    return target
      ? {
          target: target.label,
          fields: removalEffects[kind],
          version: JSON.stringify(target.version)
        }
      : null;
  };
}

export const sportsCoveragePresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const body = object(input.body);
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.assignments)) return null;
  const assignments = await Promise.all(
    body.assignments.map((value) => assignmentLabel(db, ctx.actorUserId, value))
  );
  if (assignments.some((value) => value === null)) return null;
  return {
    content: body.assignments.every((value) => object(value)?.kind === "sport")
      ? "user_authored"
      : "outside",
    target: "Your ESPN sports coverage",
    fields: [
      {
        label: "Effect",
        value: assignments.length
          ? "Replace all current ESPN headline coverage assignments with the complete list below. Any assignment not listed will be removed."
          : "Remove all ESPN headline coverage assignments and turn ESPN headlines off."
      },
      { label: "ESPN headlines", value: assignments.length ? "Turn on" : "Turn off" },
      ...(assignments.length
        ? assignments.map((value, index) => ({
            label: `New coverage ${index + 1}`,
            value: value!.label
          }))
        : [{ label: "New coverage", value: "None" }])
    ],
    version: JSON.stringify(assignments.map((value) => value!.version))
  };
};

export const sportsStandingsPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const body = object(input.body);
  if (!body) return null;
  const declarations: Record<string, ApprovalFieldMap[string]> = {
    selectedCompetitionKeys: {
      label: "Competitions",
      present: (value) => {
        if (!Array.isArray(value)) return null;
        const labels = value.map(competitionLabel);
        if (labels.some((label) => !label)) return null;
        return labels.length
          ? labels.map((label, index) => ({ label: `Competition ${index + 1}`, value: label! }))
          : "No selected competitions";
      }
    }
  };
  let viewVersion: unknown = null;
  if (Object.hasOwn(body, "lastViewed")) {
    if (body.lastViewed === null)
      declarations.lastViewed = {
        label: "Last viewed standings",
        present: (value) => (value === null ? "Clear remembered view" : null)
      };
    else {
      const last = object(body.lastViewed);
      const competition = competitionLabel(last?.competitionKey);
      if (!last || !competition || typeof last.competitionKey !== "string") return null;
      let view: string | null = null;
      if (last.viewKey !== null) {
        const response = await sportsApprovalStandings(last.competitionKey);
        const resolved = buildViews(response.group.sections).find(
          (candidate) => candidate.key === last.viewKey
        );
        if (!resolved) return null;
        view = resolved.label;
        viewVersion = [last.competitionKey, resolved.key, resolved.label];
      }
      const nested = presentApprovalFields(
        last,
        {
          competitionKey: {
            label: "Last viewed competition",
            present: (value) => (value === last.competitionKey ? competition : null)
          },
          viewKey: {
            label: "Last viewed section",
            present: (value) =>
              value === null ? "Default view" : value === last.viewKey ? view : null
          },
          viewLabel: {
            label: "Remembered section label",
            present: (value) => (value === null ? "None" : approvalText(value))
          }
        },
        ["competitionKey", "viewKey", "viewLabel"]
      );
      if (!nested) return null;
      declarations.lastViewed = { label: "Last viewed standings", present: () => nested };
    }
  }
  const fields = presentApprovalFields(body, declarations);
  return fields?.length
    ? {
        content: viewVersion === null ? "user_authored" : "outside",
        target: "Your sports standings preferences",
        fields,
        version: JSON.stringify(viewVersion)
      }
    : null;
};

export function sportsSourcePresentation(
  action: "new-source" | "assignment-replacement" | "recipe-rebuild" | "remove" | "retry"
): ToolApprovalPresentation {
  return async (db, input, ctx) => {
    assertDataContextDb(db);
    const source =
      action === "new-source" ? null : await sourceLabel(db, ctx.actorUserId, input.sourceId);
    if (action !== "new-source" && !source) return null;
    if (action === "remove" || action === "retry") {
      const fields = presentApprovalFields(
        input,
        {
          sourceId: {
            label: "Source",
            present: (value) => (value === input.sourceId ? source!.label : null)
          }
        },
        ["sourceId"]
      );
      return fields
        ? {
            target: source!.label,
            fields: [...fields, ...(action === "remove" ? removalEffects.source : [])],
            version: JSON.stringify(source!.version)
          }
        : null;
    }
    if (typeof input.confirmationId !== "string") return null;
    const preview = sportsApprovalPreview(ctx.actorUserId, input.confirmationId);
    if (
      !preview ||
      preview.kind !== action ||
      ("sourceId" in preview && preview.sourceId !== input.sourceId)
    )
      return null;
    const expected = preview.candidate;
    if (!Array.isArray(input.targets) || input.targets.length !== expected.targets.length)
      return null;
    const targets: ApprovalField[] = [];
    const targetVersions: unknown[] = [];
    for (const [index, value] of input.targets.entries()) {
      const target = object(value);
      if (!target || Object.keys(target).length !== 2 || typeof target.targetUrl !== "string")
        return null;
      const expectedTarget = expected.targets[index]!;
      const resolved = await assignmentLabel(db, ctx.actorUserId, target.target);
      const actualTarget = object(target.target);
      if (
        !resolved ||
        !actualTarget ||
        target.targetUrl !== expectedTarget.targetUrl ||
        actualTarget.kind !== expectedTarget.target.kind
      )
        return null;
      if (
        expectedTarget.target.kind === "sport"
          ? actualTarget.sportKey !== expectedTarget.target.sportKey
          : actualTarget.followId !== expectedTarget.target.followId
      )
        return null;
      targets.push(
        { label: `Coverage ${index + 1}`, value: resolved.label },
        { label: `Source URL ${index + 1}`, value: target.targetUrl }
      );
      targetVersions.push(resolved.version);
    }
    const fields = presentApprovalFields(
      input,
      {
        ...(source
          ? {
              sourceId: {
                label: "Source",
                present: (value: unknown) => (value === input.sourceId ? source.label : null)
              }
            }
          : {}),
        confirmationId: {
          label: "Verified preview",
          present: (value) => (value === input.confirmationId ? expected.label : null)
        },
        authorizationAcknowledgement: {
          label: "Authorization",
          present: (value) =>
            value === preview.authorizationAcknowledgement
              ? preview.authorizationAcknowledgement
              : null
        },
        canonicalDomain: {
          label: "Publisher",
          present: (value) => (value === expected.canonicalDomain ? expected.canonicalDomain : null)
        },
        confirmedFetchHosts: {
          label: "Allowed hosts",
          present: (value) =>
            JSON.stringify(value) === JSON.stringify(expected.confirmedFetchHosts)
              ? expected.confirmedFetchHosts.length
                ? expected.confirmedFetchHosts.map((host, index) => ({
                    label: `Allowed host ${index + 1}`,
                    value: host
                  }))
                : "None"
              : null
        },
        targets: { label: "Coverage", present: () => (targets.length ? targets : "No assignments") }
      },
      [
        ...(source ? ["sourceId"] : []),
        "confirmationId",
        "authorizationAcknowledgement",
        "canonicalDomain",
        "confirmedFetchHosts",
        "targets"
      ]
    );
    return fields
      ? {
          target: source?.label ?? expected.label,
          fields: [
            ...fields,
            ...(action === "assignment-replacement"
              ? [
                  {
                    label: "Effect",
                    value: input.targets.length
                      ? "Replace all coverage assignments for this source with the complete list shown. Any assignment not listed will be removed."
                      : "Remove all coverage assignments for this source."
                  }
                ]
              : [])
          ],
          version: JSON.stringify([input.confirmationId, preview, source?.version, targetVersions])
        }
      : null;
  };
}

/** Outbound reads may also need a card when outside content influenced the call. */
export function sportsPublicReadPresentation(
  kind: "teams" | "standings" | "icon"
): RouteApprovalPresentation {
  return async (db, input, ctx) => {
    if (!presentApprovalFields(input.body, {})) return null;
    if (kind === "icon") {
      assertDataContextDb(db);
      if (
        Object.keys(input.params).length !== 1 ||
        (input.query && Object.keys(input.query).length)
      )
        return null;
      const source = await sourceLabel(db, ctx.actorUserId, input.params.sourceId);
      return source
        ? { target: source.label, fields: [], version: JSON.stringify(source.version) }
        : null;
    }
    const values = kind === "teams" ? input.params : input.query;
    if (
      kind === "teams"
        ? Boolean(input.query && Object.keys(input.query).length)
        : Object.keys(input.params).length > 0
    )
      return null;
    const fields = presentApprovalFields(
      values,
      { competitionKey: { label: "Competition", present: competitionLabel } },
      ["competitionKey"]
    );
    return fields ? { content: "user_authored", target: fields[0]!.value, fields } : null;
  };
}
