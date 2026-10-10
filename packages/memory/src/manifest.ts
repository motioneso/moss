import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  getMemoryDashboardRouteSchema,
  getMemoryPendingCandidatesRouteSchema,
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
import {
  memoryCandidateTarget,
  memoryEntityTarget,
  memoryFactTarget,
  memoryFactResolutionTarget
} from "./chat-targets.js";
import {
  memoryPinPresentation,
  memorySupersedePresentation,
  memoryDeleteEntityPresentation,
  memoryDatesPresentation,
  memoryRejectPresentation,
  memoryAcceptPresentation,
  memoryEditEntityPresentation,
  memoryCreateEntityPresentation,
  memoryRememberPresentation,
  memoryRememberRoutePresentation
} from "./action-presentations.js";
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
      chat: {
        access: "blocked",
        blockedBecause: "data_scope_consent",
        content: "outside",
        coveredBy: "memory.recall"
      },
      responseSchema: getMemoryGraphRecallRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "GET",
      path: "/api/memory/graph/core",
      chat: { access: "blocked", blockedBecause: "data_scope_consent", content: "outside" },
      responseSchema: getMemoryGraphCoreRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "POST",
      path: "/api/memory/graph/entities",
      chat: {
        presentation: memoryCreateEntityPresentation,
        access: "write",
        title: "Add memory entity",
        content: "outside"
      },
      requestSchema: postMemoryGraphEntityRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts",
      chat: {
        access: "write",
        title: "Remember a fact",
        content: "outside",
        coveredBy: "memory.remember",
        presentation: memoryRememberRoutePresentation
      },
      requestSchema: postMemoryGraphFactRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/pin",
      chat: {
        target: memoryFactTarget,
        presentation: memoryPinPresentation,
        access: "write",
        title: "Pin or unpin memory fact",
        content: "user_authored"
      },
      requestSchema: postMemoryGraphPinRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/confirm",
      chat: {
        access: "blocked",
        blockedBecause: "data_scope_consent",
        title: "Confirm memory and supersede conflicts",
        content: "outside",
        target: memoryFactResolutionTarget
      },
      requestSchema: postMemoryGraphConfirmRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/correct",
      chat: {
        access: "blocked",
        blockedBecause: "data_scope_consent",
        title: "Replace memory and supersede conflicts",
        content: "outside",
        target: memoryFactResolutionTarget
      },
      requestSchema: postMemoryGraphCorrectRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/status",
      chat: {
        access: "blocked",
        blockedBecause: "data_scope_consent",
        title: "Change memory visibility",
        content: "outside",
        target: memoryFactTarget
      },
      requestSchema: postMemoryGraphStatusRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/mark-stale",
      chat: {
        access: "blocked",
        blockedBecause: "data_scope_consent",
        title: "Mark memory fact stale",
        content: "outside"
      },
      requestSchema: postMemoryGraphMarkStaleRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/graph/facts/:id/supersede",
      chat: {
        access: "destructive",
        title: "Supersede memory fact",
        presentation: memorySupersedePresentation,
        content: "outside",
        target: memoryFactTarget
      },
      requestSchema: postMemoryGraphSupersedeRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "DELETE",
      path: "/api/memory/graph/facts/:id",
      chat: {
        access: "destructive",
        title: "Forget memory fact",
        content: "outside",
        target: memoryFactTarget,
        coveredBy: "memory.forget"
      },
      permissionId: "memory.manage"
    },
    {
      method: "GET",
      path: "/api/memory/dashboard",
      chat: { access: "blocked", blockedBecause: "data_scope_consent", content: "outside" },
      responseSchema: getMemoryDashboardRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "GET",
      path: "/api/memory/candidates",
      chat: { access: "read", title: "List pending memory suggestions", content: "outside" },
      requestSchema: getMemoryPendingCandidatesRouteSchema.querystring,
      responseSchema: getMemoryPendingCandidatesRouteSchema.response[200],
      permissionId: "memory.view"
    },
    {
      method: "POST",
      path: "/api/memory/candidates/:id/accept",
      // Ben, 2026-10-06: accepting a suggestion from chat always shows an approval card.
      chat: {
        access: "destructive",
        title: "Accept memory suggestion",
        emptyBody: "object",
        presentation: memoryAcceptPresentation,
        content: "user_authored",
        target: memoryCandidateTarget
      },
      requestSchema: postMemoryCandidateAcceptRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/candidates/:id/reject",
      chat: {
        access: "write",
        title: "Reject memory suggestion",
        presentation: memoryRejectPresentation,
        content: "user_authored",
        target: memoryCandidateTarget
      },
      requestSchema: postMemoryCandidateRejectRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "POST",
      path: "/api/memory/candidates/:id/suppress",
      chat: {
        access: "write",
        title: "Suppress memory suggestion",
        presentation: memoryRejectPresentation,
        content: "user_authored",
        target: memoryCandidateTarget
      },
      requestSchema: postMemoryCandidateSuppressRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "PATCH",
      path: "/api/memory/graph/facts/:id",
      chat: {
        access: "destructive",
        title: "Change memory dates and recall visibility",
        presentation: memoryDatesPresentation,
        content: "outside",
        target: memoryFactTarget
      },
      requestSchema: patchMemoryFactDashboardRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "PATCH",
      path: "/api/memory/graph/entities/:id",
      chat: {
        target: memoryEntityTarget,
        presentation: memoryEditEntityPresentation,
        access: "write",
        title: "Update memory entity",
        content: "user_authored"
      },
      requestSchema: patchMemoryEntityDashboardRouteSchema.body,
      permissionId: "memory.manage"
    },
    {
      method: "DELETE",
      path: "/api/memory/graph/entities/:id",
      chat: {
        access: "destructive",
        title: "Delete memory entity",
        presentation: memoryDeleteEntityPresentation,
        content: "outside",
        target: memoryEntityTarget
      },
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
      content: "outside",
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
      actionLabel: "Remember a fact",
      approvalPresentation: memoryRememberPresentation,
      description: "Create a source-backed graph memory fact for the active actor.",
      permissionId: "memory.manage",
      actionFamilyId: "memory_management",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      inputSchema: memoryRememberToolInputSchema,
      execute: memoryRememberExecute
    },
    {
      name: "memory.forget",
      description:
        "Forget a saved graph memory fact after the user approves its exact text. To reject a pending memory suggestion, find the suggestion action instead.",
      permissionId: "memory.manage",
      risk: "destructive",
      // Receipt-only result; the per-call target is admitted as outside before its card.
      content: "user_authored",
      safeErrors: true,
      requiresServices: ["memoryForget"],
      requiresPerCallResolution: true,
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
      id: "memory.forget_approval",
      description:
        "Memory deletion asks first with full text, never IDs. Both chat paths check the exact version. Changed or reloaded requests need a new approval. Displayed targets count as outside content. Rejection tells Moss you declined."
    },
    {
      id: "memory.chat_app_actions",
      description:
        "App actions create facts and entities and list or decide pending suggestions. Cards show plain memory text without IDs; hidden snapshots bind the target. Accepting, deleting and superseding ask first. Retained-source recall stays blocked."
    },
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
        "Review pending suggestions in Memory settings or chat. Accepting in chat asks first and " +
        "adds a memory, keeping older ones. Accept, reject and suppress only pending suggestions; " +
        "repeat or conflicting decisions are refused."
    },
    {
      id: "memory.pending_suggestion_counts",
      description:
        "Chat reads 5 pending suggestions per cursor page; decisions do not shift later pages. " +
        "Total counts all pending, remaining counts after the page. Restart for newer arrivals. " +
        "Text has excerpt flags; IDs and approval labels stay complete."
    },
    {
      id: "memory.notes_ingest",
      description:
        "Read your linked notes into Moss by splitting each note into passages and keeping them " +
        "with an embedding model, so you can search your notes by meaning. A note you delete or " +
        "move out of the folder is dropped from search on the next sync."
    }
  ]
};
