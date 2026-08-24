import { fileURLToPath } from "node:url";

import type { MossModuleManifest, ModuleAiRequirementManifest } from "@moss/module-sdk";
import {
  confirmSportsSourceSchema,
  createSportsFollowRequestSchema,
  createSportsFollowResponseSchema,
  deleteSportsCustomSourceSchema,
  deleteSportsFollowResponseSchema,
  previewSportsSourceSchema,
  previewSportsSourceAssignmentsSchema,
  previewSportsSourceRecipeSchema,
  retrySportsSourceSchema,
  sportsCatalogResponseSchema,
  sportsCustomSourcesResponseSchema,
  sportsFollowsResponseSchema,
  sportsLeagueTeamsResponseSchema,
  sportsOverviewResponseSchema,
  sportsStandingsResponseSchema,
  sportsTeamSearchResponseSchema,
  updateSportsSourceAssignmentsSchema,
  updateSportsSourceRecipeSchema
} from "@moss/shared";

import { sportsFollowedFactsTodayExecute } from "./briefing-tool.js";
import { collectSportsSourcesExportSection } from "./data-lifecycle.js";
import {
  sportsFollowTeamExecute,
  sportsConfirmSourceAssignmentsExecute,
  sportsConfirmSourceExecute,
  sportsConfirmSourceRecipeExecute,
  sportsListSourcesExecute,
  sportsPreviewSourceAssignmentsExecute,
  sportsPreviewSourceExecute,
  sportsRebuildSourceRecipeExecute,
  sportsRemoveSourceExecute,
  sportsRetrySourceExecute,
  sportsUnfollowTeamExecute,
  summarizeSportsConfirmSource,
  summarizeSportsConfirmSourceAssignments,
  summarizeSportsConfirmSourceRecipe,
  summarizeSportsFollowTeam,
  summarizeSportsRemoveSource,
  summarizeSportsRetrySource,
  summarizeSportsUnfollowTeam
} from "./chat-tools.js";
import { ESPN_FETCH_HOSTS, ESPN_IMAGE_HOSTS } from "./source/espn-source.js";

export const SPORTS_MODULE_ID = "sports";

// Same cadence as the pre-connector-SDK `SportsCache` TTL constants (now retired) — this slice
// is a mechanical migration, not a behavior change (docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md).
const TEAMS_TTL_MS = 24 * 60 * 60 * 1000;
const SCOREBOARD_TTL_MS = 3 * 60 * 1000;
const STANDINGS_HEADLINES_SCHEDULE_TTL_MS = 10 * 60 * 1000;
// A published article's body is effectively immutable, so it caches far longer than the feed that
// surfaces it — one fetch per featured article, not per overview (#857). The cache key includes the
// article id, so a new feature just misses and fetches its own body.
const ARTICLE_BODY_TTL_MS = 6 * 60 * 60 * 1000;

// Input bound for the two auto-running follow tools' catalog keys (#1265 security QA
// BLOCKING-1b). Competition keys are lowercase alphanumeric with dots ("nfl", "eng.1"); ESPN team
// keys are a lowercased abbreviation or a bare numeric id (espn-source.ts `listTeams`). Nothing in
// either shape can traverse or escape a URL path segment, which is where these values eventually
// land (espn-source.ts `getSchedule`). This is a schema-level belt only — the service still closes
// teamKey against the live league roster, and the URL site still percent-encodes.
const CATALOG_KEY_PATTERN = "^[a-z0-9.]{1,100}$";
const SOURCE_ID_PROPERTY = { type: "string", format: "uuid" } as const;

export const sportsModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

// #1572: same AI-availability gate shape as News' newsAddSourceRequirement, reused by
// module-registry's composition root to build the `availability.hasJsonModel` check.
export const sportsAddSourceRequirement = {
  service: "module.sports",
  capability: "json",
  tier: "economy"
} as const satisfies ModuleAiRequirementManifest;

export const sportsModuleManifest = {
  id: SPORTS_MODULE_ID,
  name: "Sports",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "user-toggleable",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: false,
    supportsUserDisable: true
  },
  database: {
    migrations: [
      "sql/0133_sports_follows.sql",
      "sql/0185_sports_whole_league_dedupe.sql",
      "sql/0186_sports_whole_league_unique.sql",
      "sql/0190_sports_custom_sources.sql",
      "sql/0191_sports_public_source_runtime.sql"
    ],
    migrationDirectories: ["packages/sports/sql"],
    ownedTables: [
      "app.sports_follows",
      "app.sports_custom_sources",
      "app.sports_source_assignments",
      "app.sports_policy_verdicts",
      "app.sports_headline_prefs"
    ]
  },
  navigation: [
    {
      id: "sports",
      label: "Sports",
      description: "Follow scores, schedules, and standings for selected teams.",
      path: "/sports",
      icon: "trophy",
      order: 35,
      permissionId: "sports.view"
    }
  ],
  settings: [
    {
      id: "sports.follows",
      label: "Sports",
      description: "Choose the teams and leagues shown in Sports.",
      path: "/settings/modules/sports",
      scope: "user",
      order: 35,
      permissionId: "sports.view",
      entry: "./settings"
    }
  ],
  permissions: [
    {
      id: "sports.view",
      label: "View sports",
      description: "Read the active actor's followed competitions/teams and public sports data.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "sports.follow",
      label: "Manage sports follows",
      description: "Create and delete the active actor's own sports follows.",
      scope: "user",
      actions: ["create", "delete"]
    },
    {
      id: "sports.sources",
      label: "Manage custom sports news sources",
      description:
        "Add, assign, and remove the active actor's own custom public news sources for sports.",
      scope: "user",
      actions: ["create", "update", "delete"]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/sports/catalog",
      responseSchema: sportsCatalogResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "GET",
      path: "/api/sports/leagues/:competitionKey/teams",
      responseSchema: sportsLeagueTeamsResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "GET",
      path: "/api/sports/teams/search",
      responseSchema: sportsTeamSearchResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "GET",
      path: "/api/sports/overview",
      responseSchema: sportsOverviewResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "GET",
      path: "/api/sports/standings",
      responseSchema: sportsStandingsResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "GET",
      path: "/api/sports/follows",
      responseSchema: sportsFollowsResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "POST",
      path: "/api/sports/follows",
      requestSchema: createSportsFollowRequestSchema,
      responseSchema: createSportsFollowResponseSchema,
      permissionId: "sports.follow"
    },
    {
      method: "DELETE",
      path: "/api/sports/follows/:id",
      responseSchema: deleteSportsFollowResponseSchema,
      permissionId: "sports.follow"
    },
    {
      method: "GET",
      path: "/api/sports/sources",
      responseSchema: sportsCustomSourcesResponseSchema,
      permissionId: "sports.view"
    },
    {
      method: "POST",
      path: "/api/sports/sources/preview",
      requestSchema: previewSportsSourceSchema.body,
      responseSchema: previewSportsSourceSchema,
      permissionId: "sports.sources"
    },
    {
      method: "POST",
      path: "/api/sports/sources",
      requestSchema: confirmSportsSourceSchema.body,
      responseSchema: confirmSportsSourceSchema,
      permissionId: "sports.sources"
    },
    {
      method: "POST",
      path: "/api/sports/sources/:id/assignments/preview",
      requestSchema: previewSportsSourceAssignmentsSchema.body,
      responseSchema: previewSportsSourceAssignmentsSchema,
      permissionId: "sports.sources"
    },
    {
      method: "PATCH",
      path: "/api/sports/sources/:id/assignments",
      requestSchema: updateSportsSourceAssignmentsSchema.body,
      responseSchema: updateSportsSourceAssignmentsSchema,
      permissionId: "sports.sources"
    },
    {
      method: "POST",
      path: "/api/sports/sources/:id/retry",
      responseSchema: retrySportsSourceSchema,
      permissionId: "sports.sources"
    },
    {
      method: "POST",
      path: "/api/sports/sources/:id/rebuild/preview",
      responseSchema: previewSportsSourceRecipeSchema,
      permissionId: "sports.sources"
    },
    {
      method: "PATCH",
      path: "/api/sports/sources/:id/rebuild",
      requestSchema: updateSportsSourceRecipeSchema.body,
      responseSchema: updateSportsSourceRecipeSchema,
      permissionId: "sports.sources"
    },
    {
      method: "DELETE",
      path: "/api/sports/sources/:id",
      responseSchema: deleteSportsCustomSourceSchema,
      permissionId: "sports.sources"
    }
  ],
  assistantActionFamilies: [
    {
      id: "sports_follows",
      label: "Sports follows",
      description: "Follow and unfollow the active actor's own teams and competitions.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    },
    {
      id: "sports.sources",
      label: "Sports sources",
      description: "Add, update, retry, rebuild, and remove the active actor's sports sources.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "sports.followedFactsToday",
      description:
        "List compact, non-sensitive facts about the actor's followed teams/competitions playing today (one short line per follow). Read-only; briefing-oriented, not a live scores/schedule browser.",
      permissionId: "sports.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: sportsFollowedFactsTodayExecute
    },
    {
      name: "sports.followTeam",
      description:
        "Follow a team or an entire competition/league (e.g. 'the Yankees' or 'the Premier League'). Resolve the name to a catalog competitionKey (and teamKey for a specific team) via the sports catalog/search first, then call this with the exact keys.",
      permissionId: "sports.follow",
      actionFamilyId: "sports_follows",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          competitionKey: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            pattern: CATALOG_KEY_PATTERN,
            description: 'Catalog competition key, e.g. "nfl" or "eng.1"'
          },
          teamKey: {
            type: "string",
            maxLength: 100,
            pattern: CATALOG_KEY_PATTERN,
            description:
              "Catalog team key within the competition; omit to follow the whole competition"
          }
        },
        required: ["competitionKey"]
      },
      summarize: summarizeSportsFollowTeam,
      execute: sportsFollowTeamExecute
    },
    {
      name: "sports.unfollowTeam",
      description:
        "Stop following a team or competition previously followed. Requires the same competitionKey (and teamKey if a specific team) used to follow it.",
      permissionId: "sports.follow",
      actionFamilyId: "sports_follows",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          competitionKey: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            pattern: CATALOG_KEY_PATTERN,
            description: 'Catalog competition key, e.g. "nfl" or "eng.1"'
          },
          teamKey: {
            type: "string",
            maxLength: 100,
            pattern: CATALOG_KEY_PATTERN,
            description:
              "Catalog team key within the competition; omit to unfollow the whole competition"
          }
        },
        required: ["competitionKey"]
      },
      summarize: summarizeSportsUnfollowTeam,
      execute: sportsUnfollowTeamExecute
    },
    {
      name: "sports.listSources",
      description:
        "List the active actor's bounded public sports sources, assignments, health, timestamps, and safe recovery status. Never returns recipes or opaque parameters.",
      permissionId: "sports.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: sportsListSourcesExecute
    },
    {
      name: "sports.previewSource",
      description:
        "Preview and safely verify one public unauthenticated sports publisher and optional followed targets before confirmation. Returned headline samples are external publisher content.",
      permissionId: "sports.sources",
      risk: "read",
      externalContent: true,
      inputSchema: previewSportsSourceSchema.body,
      execute: sportsPreviewSourceExecute
    },
    {
      name: "sports.confirmSource",
      description:
        "Confirm a sports source from its actor-bound preview using the exact displayed publisher, hosts, targets, and authorization acknowledgement.",
      permissionId: "sports.sources",
      actionFamilyId: "sports.sources",
      risk: "write",
      selfOperationGrant: "confirm_always",
      inputSchema: confirmSportsSourceSchema.body,
      summarize: summarizeSportsConfirmSource,
      execute: sportsConfirmSourceExecute
    },
    {
      name: "sports.previewSourceAssignments",
      description:
        "Preview an exact replacement assignment set for one sports source. Added target samples are external publisher content.",
      permissionId: "sports.sources",
      risk: "read",
      externalContent: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceId: SOURCE_ID_PROPERTY,
          ...previewSportsSourceAssignmentsSchema.body.properties
        },
        required: ["sourceId", "assignments"]
      },
      execute: sportsPreviewSourceAssignmentsExecute
    },
    {
      name: "sports.confirmSourceAssignments",
      description:
        "Confirm the exact actor-bound sports source assignment replacement shown by the preview.",
      permissionId: "sports.sources",
      actionFamilyId: "sports.sources",
      risk: "write",
      selfOperationGrant: "confirm_always",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { sourceId: SOURCE_ID_PROPERTY, ...confirmSportsSourceSchema.body.properties },
        required: ["sourceId", ...confirmSportsSourceSchema.body.required]
      },
      summarize: summarizeSportsConfirmSourceAssignments,
      execute: sportsConfirmSourceAssignmentsExecute
    },
    {
      name: "sports.rebuildSourceRecipe",
      description:
        "Preview a bounded safe rebuild of one saved sports source recipe without changing it. Samples are external publisher content.",
      permissionId: "sports.sources",
      risk: "read",
      externalContent: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { sourceId: SOURCE_ID_PROPERTY },
        required: ["sourceId"]
      },
      execute: sportsRebuildSourceRecipeExecute
    },
    {
      name: "sports.confirmSourceRecipe",
      description:
        "Confirm the exact actor-bound sports source recipe rebuild shown by the preview.",
      permissionId: "sports.sources",
      actionFamilyId: "sports.sources",
      risk: "write",
      selfOperationGrant: "confirm_always",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { sourceId: SOURCE_ID_PROPERTY, ...confirmSportsSourceSchema.body.properties },
        required: ["sourceId", ...confirmSportsSourceSchema.body.required]
      },
      summarize: summarizeSportsConfirmSourceRecipe,
      execute: sportsConfirmSourceRecipeExecute
    },
    {
      name: "sports.retrySource",
      description:
        "Retry every verified target for one actor-owned sports source through pinned safe fetch with no browser.",
      permissionId: "sports.sources",
      actionFamilyId: "sports.sources",
      risk: "write",
      selfOperationGrant: "confirm_always",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { sourceId: SOURCE_ID_PROPERTY },
        required: ["sourceId"]
      },
      summarize: summarizeSportsRetrySource,
      execute: sportsRetrySourceExecute
    },
    {
      name: "sports.removeSource",
      description: "Remove one actor-owned sports source and its assignments.",
      permissionId: "sports.sources",
      actionFamilyId: "sports.sources",
      risk: "destructive",
      selfOperationGrant: "confirm_always",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { sourceId: SOURCE_ID_PROPERTY },
        required: ["sourceId"]
      },
      summarize: summarizeSportsRemoveSource,
      execute: sportsRemoveSourceExecute
    }
  ],
  dataLifecycle: {
    exportSections: [
      {
        key: "sportsSources",
        displayName: "Sports sources",
        collect: collectSportsSourcesExportSection
      }
    ],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.sports_follows" },
        { table: "app.sports_custom_sources" },
        { table: "app.sports_source_assignments" },
        { table: "app.sports_policy_verdicts" },
        { table: "app.sports_headline_prefs" }
      ]
    }
  },
  externalSources: [
    {
      id: "espn",
      displayName: "ESPN",
      credential: "none" as const,
      fetchHosts: ESPN_FETCH_HOSTS,
      imageHosts: ESPN_IMAGE_HOSTS,
      datasets: [
        { key: "teams", ttlMs: TEAMS_TTL_MS, staleness: "degrade-empty" },
        { key: "scoreboard", ttlMs: SCOREBOARD_TTL_MS, staleness: "degrade-empty" },
        {
          key: "standings",
          ttlMs: STANDINGS_HEADLINES_SCHEDULE_TTL_MS,
          staleness: "degrade-empty"
        },
        {
          key: "headlines",
          ttlMs: STANDINGS_HEADLINES_SCHEDULE_TTL_MS,
          staleness: "degrade-empty"
        },
        { key: "schedule", ttlMs: STANDINGS_HEADLINES_SCHEDULE_TTL_MS, staleness: "degrade-empty" },
        // Per-article body for the NewsBand featured hero (#857). MUST be declared here or the
        // dataset runtime throws "Unknown dataset" the moment the service requests it, 500ing the
        // whole overview — the adapter handling the key is not enough on its own.
        { key: "articleBody", ttlMs: ARTICLE_BODY_TTL_MS, staleness: "degrade-empty" }
      ]
    }
  ]
} satisfies MossModuleManifest;
