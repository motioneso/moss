import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  getMemoryDashboardRouteSchema,
  getMemoryGraphCoreRouteSchema,
  getMemoryGraphRecallRouteSchema,
  patchMemoryEntityDashboardRouteSchema,
  patchMemoryFactDashboardRouteSchema,
  postMemoryCandidateAcceptRouteSchema,
  postMemoryCandidateRejectRouteSchema,
  postMemoryCandidateSuppressRouteSchema,
  postMemoryGraphConfirmRouteSchema,
  postMemoryGraphCorrectRouteSchema,
  postMemoryGraphEntityRouteSchema,
  postMemoryGraphFactRouteSchema,
  postMemoryGraphMarkStaleRouteSchema,
  postMemoryGraphPinRouteSchema,
  postMemoryGraphStatusRouteSchema,
  postMemoryGraphSupersedeRouteSchema
} from "@moss/shared";
import { memoryForgetExecute, memoryRecallExecute, memoryRememberExecute } from "./graph-tools.js";

const memoryRememberToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["predicate", "source"],
  properties: {
    subjectEntityId: { type: "string" },
    predicate: {
      type: "string",
      enum: [
        "prefers",
        "works_on",
        "has_goal",
        "has_constraint",
        "decided",
        "related_to",
        "owes",
        "waiting_on",
        "mentioned_in",
        "alias_of"
      ]
    },
    objectEntityId: { type: "string" },
    objectText: { type: "string" },
    confidence: { type: "number" },
    provenance: { type: "string", enum: ["volunteered", "inferred", "confirmed", "imported"] },
    importance: { type: "number" },
    pinned: { type: "boolean" },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["sourceKind", "sourceRef", "excerpt"],
      properties: {
        sourceKind: {
          type: "string",
          enum: ["chat", "note", "task", "email", "calendar", "manual"]
        },
        sourceRef: { type: "string" },
        sourceLabel: { type: "string" },
        excerpt: { type: "string" }
      }
    }
  }
} as const;

export const MEMORY_MODULE_ID = "memory";
export const memorySqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const memoryModuleManifest: MossModuleManifest = {
  id: MEMORY_MODULE_ID,
  name: "Memory",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true
  },
  database: {
    migrations: [
      "sql/0030_memory_index.sql",
      "sql/0032_memory_embedding_768.sql",
      "sql/0040_memory_chat_source.sql",
      "sql/0041_memory_facts.sql"
    ],
    migrationDirectories: ["packages/memory/sql"],
    ownedTables: [
      "app.memory_chunks",
      "app.memory_links",
      "app.memory_file_index",
      "app.chat_memory_facts",
      "app.memory_entities",
      "app.memory_facts",
      "app.memory_episodes",
      "app.memory_fact_sources",
      "app.memory_aliases",
      "app.memory_search_documents",
      "app.memory_legacy_fact_migrations",
      "app.memory_conflict_groups",
      "app.memory_candidates"
    ]
  },
  routes: [
    {
      method: "GET",
      path: "/api/memory/graph/recall",
      responseSchema: getMemoryGraphRecallRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "GET",
      path: "/api/memory/graph/core",
      responseSchema: getMemoryGraphCoreRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "POST",
      path: "/api/memory/graph/entities",
      requestSchema: postMemoryGraphEntityRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts",
      requestSchema: postMemoryGraphFactRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/pin",
      requestSchema: postMemoryGraphPinRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/confirm",
      requestSchema: postMemoryGraphConfirmRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/correct",
      requestSchema: postMemoryGraphCorrectRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/status",
      requestSchema: postMemoryGraphStatusRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/mark-stale",
      requestSchema: postMemoryGraphMarkStaleRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/supersede",
      requestSchema: postMemoryGraphSupersedeRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "DELETE",
      path: "/api/memory/graph/facts/:id",
      permissionId: "memory.manage"
    },
    {
      method: "GET",
      path: "/api/memory/dashboard",
      responseSchema: getMemoryDashboardRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "POST",
      path: "/api/memory/candidates/:id/accept",
      requestSchema: postMemoryCandidateAcceptRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/candidates/:id/reject",
      requestSchema: postMemoryCandidateRejectRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/candidates/:id/suppress",
      requestSchema: postMemoryCandidateSuppressRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "PATCH",
      path: "/api/memory/graph/facts/:id",
      requestSchema: patchMemoryFactDashboardRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "PATCH",
      path: "/api/memory/graph/entities/:id",
      requestSchema: patchMemoryEntityDashboardRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "DELETE",
      path: "/api/memory/graph/entities/:id",
      permissionId: "memory.manage"
    }
  ],
  assistantActionFamilies: [
    {
      id: "memory_management",
      label: "Memory management",
      description: "Remember graph memory facts on the active actor's behalf.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "memory.recall",
      description: "Recall source-backed graph memory owned by the active actor.",
      permissionId: "memory.view",
      risk: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "number" }
        }
      },
      execute: memoryRecallExecute
    },
    {
      name: "memory.remember",
      description: "Create a source-backed graph memory fact for the active actor.",
      permissionId: "memory.manage",
      actionFamilyId: "memory_management",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: memoryRememberToolInputSchema,
      execute: memoryRememberExecute
    },
    {
      name: "memory.forget",
      description: "Forget a graph memory fact owned by the active actor.",
      permissionId: "memory.manage",
      risk: "destructive",
      selfOperationGrant: "confirm_always",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["factId"],
        properties: {
          factId: { type: "string" }
        }
      },
      execute: memoryForgetExecute
    }
  ],
  features: [
    {
      id: "memory.associative_graph",
      description:
        "Keep what Moss learns about you as a graph of people, things and facts, and recall the " +
        "relevant parts when answering. In Memory settings you can pin an important fact or " +
        "forget it, and review the proposed memories waiting for your decision."
    },
    {
      id: "memory.candidate_review",
      description:
        "Moss proposes new memories as it learns; in Memory settings you review each candidate and " +
        "accept, reject, or suppress it before it becomes a kept memory."
    },
    {
      id: "memory.notes_ingest",
      description:
        "Read your linked notes into Moss by splitting each note into passages and keeping them " +
        "with an embedding model, so you can search your notes by meaning."
    }
  ]
};
