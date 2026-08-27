import { fileURLToPath } from "node:url";

import type { MossModuleManifest, ModuleAiRequirementManifest } from "@moss/module-sdk";
import {
  confirmNewsSourceSchema,
  createNewsPrefRequestSchema,
  createNewsPrefResponseSchema,
  createNewsSourceExclusionSchema,
  createNewsTopicSchema,
  deleteNewsCustomSourceSchema,
  deleteNewsPrefResponseSchema,
  deleteNewsSourceExclusionSchema,
  deleteNewsTopicSchema,
  getNewsPersonalizationSchema,
  newsCatalogResponseSchema,
  newsOverviewResponseSchema,
  newsPrefsResponseSchema,
  previewNewsSourceSchema,
  triggerNewsRefreshSchema,
  triggerNewsRevalidationSchema,
  updateNewsTopicSchema,
  connectNewsCredentialedSourceSchema,
  listNewsSourceCredentialsSchema,
  replaceNewsSourceCredentialSchema,
  revokeNewsSourceCredentialSchema
} from "@moss/shared";

import { newsTopHeadlinesTodayExecute } from "./briefing-tool.js";
import {
  newsAddExclusionExecute,
  newsAddTopicExecute,
  newsConfirmSourceExecute,
  newsPreviewSourceExecute,
  newsRemoveSourceExecute,
  newsRemoveTopicExecute,
  summarizeNewsAddExclusion,
  summarizeNewsAddTopic,
  summarizeNewsConfirmSource,
  summarizeNewsRemoveSource,
  summarizeNewsRemoveTopic
} from "./chat-tools.js";
import { collectNewsExportSection } from "./data-lifecycle.js";
import type { NEWS_MODULE_ID } from "./module-id.js";
import { NEWS_FETCH_HOSTS, NEWS_IMAGE_HOSTS } from "./source/catalog.js";

export { NEWS_MODULE_ID } from "./module-id.js";

// Publisher front pages churn on roughly this cadence; matches sports' standings/headlines TTL
// (docs/superpowers/specs/2026-07-08-news-module.md "Caching").
const FEED_TTL_MS = 10 * 60 * 1000;

export const newsModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const newsAddSourceRequirement = {
  service: "module.news",
  capability: "json",
  tier: "economy"
} as const satisfies ModuleAiRequirementManifest;

export const newsModuleManifest = {
  // Inline literal, not the imported NEWS_MODULE_ID: the settings-ui scanner reads this
  // file statically and resolves only same-file constants, so an imported identifier makes
  // the web scan throw and the settings scan silently drop this module. `satisfies` pins
  // the literal to module-id.ts at compile time so the two can never drift (#975 Slice 4).
  id: "news" satisfies typeof NEWS_MODULE_ID,
  name: "News",
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
      "sql/0151_news_prefs.sql",
      "sql/0159_news_personalization.sql",
      "sql/0160_news_discovery.sql",
      // #975 Slice 4 — column-scoped worker UPDATE grants for provider-change revalidation.
      "sql/0161_news_revalidation.sql",
      // #2005 (part of #950) — owner-only encrypted publisher credentials.
      "sql/0200_news_source_credentials.sql"
    ],
    migrationDirectories: ["packages/news/sql"],
    ownedTables: [
      "app.news_prefs",
      // #953 Slice 1 personalization tables — owner-only FORCE RLS, no worker grants.
      "app.news_custom_sources",
      "app.news_custom_topics",
      "app.news_source_exclusions",
      "app.news_compilation_snapshots",
      "app.news_refresh_state",
      "app.news_policy_verdicts",
      // #2005 — owner-only FORCE RLS, no worker grant (see 0200).
      "app.news_source_credentials"
    ]
  },
  navigation: [
    {
      id: "news",
      label: "News",
      description: "Read personalized headlines from enabled sources.",
      path: "/news",
      icon: "newspaper",
      order: 34,
      permissionId: "news.view"
    }
  ],
  settings: [
    {
      id: "news.prefs",
      label: "News",
      description: "Choose news sources, topics, and excluded publishers.",
      path: "/settings/modules/news",
      scope: "user",
      order: 34,
      permissionId: "news.view",
      entry: "./settings"
    }
  ],
  permissions: [
    {
      id: "news.view",
      label: "View news",
      description:
        "Read the active actor's news source/topic preferences and public headlines from the curated feed catalog.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "news.prefs",
      label: "Manage news preferences",
      description:
        "Create and delete the active actor's own news source and topic preferences, including excluded publisher domains.",
      scope: "user",
      actions: ["create", "delete"]
    },
    {
      // #2005: deliberately NOT news.prefs. The assistant tools are declared under
      // news.prefs, so credential routes sit behind a permission no assistant tool holds.
      id: "news.credentials",
      label: "Manage news publisher keys",
      description:
        "Add, replace, and revoke the active actor's own publisher access keys for news sources.",
      scope: "user",
      actions: ["create", "update", "delete"]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/news/catalog",
      responseSchema: newsCatalogResponseSchema,
      permissionId: "news.view"
    },
    {
      method: "GET",
      path: "/api/news/overview",
      responseSchema: newsOverviewResponseSchema,
      permissionId: "news.view"
    },
    {
      method: "GET",
      path: "/api/news/prefs",
      responseSchema: newsPrefsResponseSchema,
      permissionId: "news.view"
    },
    {
      method: "POST",
      path: "/api/news/prefs",
      requestSchema: createNewsPrefRequestSchema,
      responseSchema: createNewsPrefResponseSchema,
      permissionId: "news.prefs"
    },
    {
      method: "DELETE",
      path: "/api/news/prefs/:id",
      responseSchema: deleteNewsPrefResponseSchema,
      permissionId: "news.prefs"
    },
    // #953 Slice 1 personalization: reads under news.view, exclusion writes under news.prefs.
    {
      method: "GET",
      path: "/api/news/personalization",
      responseSchema: getNewsPersonalizationSchema,
      permissionId: "news.view"
    },
    {
      method: "POST",
      path: "/api/news/source-exclusions",
      requestSchema: createNewsSourceExclusionSchema.body,
      responseSchema: createNewsSourceExclusionSchema,
      permissionId: "news.prefs"
    },
    {
      method: "DELETE",
      path: "/api/news/source-exclusions/:id",
      responseSchema: deleteNewsSourceExclusionSchema,
      permissionId: "news.prefs"
    },
    {
      method: "POST",
      path: "/api/news/sources/preview",
      requestSchema: previewNewsSourceSchema.body,
      responseSchema: previewNewsSourceSchema,
      permissionId: "news.prefs"
    },
    {
      method: "POST",
      path: "/api/news/sources",
      requestSchema: confirmNewsSourceSchema.body,
      responseSchema: confirmNewsSourceSchema,
      permissionId: "news.prefs"
    },
    {
      method: "DELETE",
      path: "/api/news/sources/:id",
      responseSchema: deleteNewsCustomSourceSchema,
      permissionId: "news.prefs"
    },
    {
      method: "POST",
      path: "/api/news/topics",
      requestSchema: createNewsTopicSchema.body,
      responseSchema: createNewsTopicSchema,
      permissionId: "news.prefs"
    },
    {
      method: "PATCH",
      path: "/api/news/topics/:id",
      requestSchema: updateNewsTopicSchema.body,
      responseSchema: updateNewsTopicSchema,
      permissionId: "news.prefs"
    },
    {
      method: "DELETE",
      path: "/api/news/topics/:id",
      responseSchema: deleteNewsTopicSchema,
      permissionId: "news.prefs"
    },
    {
      method: "POST",
      path: "/api/news/refresh",
      responseSchema: triggerNewsRefreshSchema,
      permissionId: "news.prefs"
    },
    {
      method: "POST",
      path: "/api/news/revalidation",
      responseSchema: triggerNewsRevalidationSchema,
      permissionId: "news.prefs"
    },
    {
      method: "GET",
      path: "/api/news/images/:articleId",
      permissionId: "news.view"
    },
    // #2005 publisher credentials. news.credentials, never news.prefs.
    {
      method: "POST",
      path: "/api/news/sources/credentialed",
      requestSchema: connectNewsCredentialedSourceSchema.body,
      responseSchema: connectNewsCredentialedSourceSchema,
      permissionId: "news.credentials"
    },
    {
      method: "POST",
      path: "/api/news/sources/:id/credential",
      requestSchema: replaceNewsSourceCredentialSchema.body,
      responseSchema: replaceNewsSourceCredentialSchema,
      permissionId: "news.credentials"
    },
    {
      method: "DELETE",
      path: "/api/news/sources/:id/credential",
      responseSchema: revokeNewsSourceCredentialSchema,
      permissionId: "news.credentials"
    },
    {
      method: "GET",
      path: "/api/news/credentials",
      responseSchema: listNewsSourceCredentialsSchema,
      permissionId: "news.credentials"
    }
  ],
  assistantActionFamilies: [
    {
      id: "news_personalization",
      label: "News personalization",
      description: "Manage the active actor's followed news sources, topics, and exclusions.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "news.topHeadlinesToday",
      description:
        "List the actor's top news headlines right now (one short 'Title — Source' line, max 5), composed from their enabled sources and topics. Read-only; briefing-oriented, not a full article browser.",
      permissionId: "news.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: newsTopHeadlinesTodayExecute
    },
    // #975 Slice 4 — chat preview/confirm for custom sources. Same two-phase shape as the
    // REST settings flow: preview verifies and stores candidates server-side; confirm writes.
    {
      name: "news.previewSource",
      description:
        "Verify a news publisher (URL or name) the actor wants to follow. Returns a confirmationId plus verified candidates (label + domain) for news.confirmSource. Read-only: verifies and caches candidates server-side, writes nothing.",
      permissionId: "news.prefs",
      risk: "read",
      // Candidate labels are derived from fetched publisher pages/feeds — untrusted
      // external text, so the gateway wraps output in the trust envelope.
      externalContent: true,
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Publisher homepage/feed URL, bare domain, or publisher name"
          }
        },
        required: ["source"]
      },
      execute: newsPreviewSourceExecute
    },
    {
      name: "news.confirmSource",
      description:
        "Add a previously previewed publisher as a followed custom news source. Requires the confirmationId from news.previewSource plus the chosen candidate's label and domain exactly as previewed.",
      permissionId: "news.prefs",
      actionFamilyId: "news_personalization",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          confirmationId: { type: "string" },
          candidateId: {
            type: "string",
            description: "Required when the preview returned more than one candidate"
          },
          label: { type: "string", description: "Candidate label exactly as previewed" },
          domain: { type: "string", description: "Candidate domain exactly as previewed" }
        },
        required: ["confirmationId", "label", "domain"]
      },
      summarize: summarizeNewsConfirmSource,
      execute: newsConfirmSourceExecute
    },
    // #975 Task 8 — remaining personalization writes. All four: write risk, classified
    // granted_at_install under news_personalization (Task 10 / Spec 2); summaries derived
    // from tool INPUT only (execute hasn't run at prompt time).
    {
      name: "news.removeSource",
      description:
        "Stop following a custom news source. Requires the source id (list them via the news personalization surface first). Removal also prunes the source's articles from the current briefing.",
      permissionId: "news.prefs",
      actionFamilyId: "news_personalization",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          sourceId: { type: "string", description: "Id of the followed custom source to remove" }
        },
        required: ["sourceId"]
      },
      summarize: summarizeNewsRemoveSource,
      execute: newsRemoveSourceExecute
    },
    {
      name: "news.addTopic",
      description:
        "Follow a custom news topic (e.g. 'local climate policy'). The topic is policy-checked before it is added.",
      permissionId: "news.prefs",
      actionFamilyId: "news_personalization",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Short human-readable topic label",
            maxLength: 80
          }
        },
        required: ["label"]
      },
      summarize: summarizeNewsAddTopic,
      execute: newsAddTopicExecute
    },
    {
      name: "news.removeTopic",
      description: "Stop following a custom news topic. Requires the topic id.",
      permissionId: "news.prefs",
      actionFamilyId: "news_personalization",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string", description: "Id of the followed custom topic to remove" }
        },
        required: ["topicId"]
      },
      summarize: summarizeNewsRemoveTopic,
      execute: newsRemoveTopicExecute
    },
    {
      name: "news.addExclusion",
      description:
        "Exclude a news publisher domain from the actor's briefing (also hides its subdomains). Excluded articles are pruned from the current briefing immediately.",
      permissionId: "news.prefs",
      actionFamilyId: "news_personalization",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Publisher domain to exclude, e.g. example.com"
          }
        },
        required: ["domain"]
      },
      summarize: summarizeNewsAddExclusion,
      execute: newsAddExclusionExecute
    }
  ],
  features: [
    {
      id: "news.add_source",
      description: "Find a publisher by URL or name and add it to personalized News.",
      requires: newsAddSourceRequirement,
      remediations: [
        {
          id: "news.add_source.configure_json_model",
          description: "Bind a JSON-capable economy model for News in Assistant & AI settings.",
          path: "/settings?section=assistant"
        }
      ],
      errors: [
        {
          code: "news.add_source.no_json_model",
          class: "prerequisite",
          remediationRef: "news.add_source.configure_json_model",
          description: "News has no JSON-capable economy model binding."
        },
        {
          code: "news.add_source.discovery_unavailable",
          class: "transient",
          description:
            "Source discovery is temporarily unavailable; retry or contact an administrator."
        }
      ]
    }
  ],
  dataLifecycle: {
    // #953 Task 6: user-authored personalization (custom sources/topics, exclusions) is
    // exported; curated news_prefs stay out (catalog references, reproducible from settings)
    // and compilation snapshots stay out (derived cache, exportable-never — deletion-only).
    exportSections: [
      {
        key: "newsPersonalization",
        displayName: "News personalization",
        collect: collectNewsExportSection
      }
    ],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.news_prefs" },
        // #953 Slice 1 — all four personalization tables key on app.users ON DELETE CASCADE.
        // Snapshots are derived data: deleted with the user, never exported (Task 6 adds the
        // export sections for sources/topics/exclusions only).
        { table: "app.news_custom_sources" },
        { table: "app.news_custom_topics" },
        { table: "app.news_source_exclusions" },
        { table: "app.news_compilation_snapshots" },
        { table: "app.news_refresh_state" },
        { table: "app.news_policy_verdicts" },
        // #2005 — credentials cascade with the user and with the parent source.
        { table: "app.news_source_credentials" }
      ]
    }
  },
  externalSources: [
    {
      id: "newsfeeds",
      displayName: "News feeds",
      credential: "none" as const,
      fetchHosts: NEWS_FETCH_HOSTS,
      imageHosts: NEWS_IMAGE_HOSTS,
      datasets: [
        // Single dataset keyed by { sourceKey, topicKey|null }. MUST be declared here or the
        // dataset runtime throws "Unknown dataset" the moment the service requests it, 500ing
        // the whole overview — the adapter handling the key is not enough on its own.
        { key: "feed", ttlMs: FEED_TTL_MS, staleness: "degrade-empty" }
      ]
    }
  ]
} satisfies MossModuleManifest;
