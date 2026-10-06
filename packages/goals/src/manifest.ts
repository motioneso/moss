import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  goalListExecute,
  goalGetExecute,
  goalCreateExecute,
  goalUpdateExecute,
  goalAddEvidenceExecute
} from "./tools.js";

export const GOALS_MODULE_ID = "jarvis.goals";

export const GOALS_MEMORY_SYNC_QUEUE = "goals-memory-sync";
export const GOALS_MEMORY_SYNC_RECONCILE_QUEUE = "goals-memory-sync-reconcile";

export const goalsModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const goalsModuleManifest: MossModuleManifest = {
  id: GOALS_MODULE_ID,
  chatRefreshTokens: ["goals.list"],
  name: "Goals",
  publisher: "Moss",
  version: "1.0.0",
  // #996/#860: Commitments (and People/Goals) moved from user-toggleable to required —
  // spec 2026-07-12-module-management-admin-ux.md decided core productivity modules
  // should never be turned off; only Wellness/Sports/News stay user-toggleable.
  lifecycle: "required",
  availability: { defaultEnabled: true, required: true },
  compatibility: { jarv1s: ">=0.0.0" },
  features: [
    {
      id: "goals.chat_app_actions",
      description:
        "App actions read and create goals. Edits and evidence additions stay unavailable because they enqueue memory synchronization."
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/goals",
      chat: { access: "read", coveredBy: "goals.list" },
      permissionId: "goals.view"
    },
    {
      method: "POST",
      path: "/api/goals",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Create goal",
        coveredBy: "goals.create"
      },
      permissionId: "goals.create"
    },
    {
      method: "GET",
      path: "/api/goals/:id",
      chat: { access: "read", coveredBy: "goals.get" },
      permissionId: "goals.view"
    },
    {
      method: "PATCH",
      path: "/api/goals/:id",
      // Both updates and evidence additions enqueue memory-sync work.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "goals.update"
    },
    {
      method: "POST",
      path: "/api/goals/:id/evidence",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "goals.update"
    }
  ],
  assistantActionFamilies: [
    {
      id: "goals_management",
      label: "Goals management",
      description: "Create, update, and read long-running goals and their evidence.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "goals.list",
      description: "List all active goals for the user.",
      permissionId: "goals.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", additionalProperties: true },
      execute: goalListExecute
    },
    {
      name: "goals.get",
      description: "Get a specific goal by ID, including its evidence.",
      permissionId: "goals.view",
      risk: "read",
      inputSchema: {
        type: "object",
        required: ["goalId"],
        properties: {
          goalId: { type: "string" }
        }
      },
      outputSchema: { type: "object", additionalProperties: true },
      execute: goalGetExecute
    },
    {
      name: "goals.create",
      description: "Create a new long-running goal.",
      permissionId: "goals.create",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "goals_management",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        required: ["title", "desiredOutcome"],
        properties: {
          title: { type: "string" },
          desiredOutcome: { type: "string" },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          reviewCadence: {
            type: "string",
            enum: ["none", "daily", "weekly", "biweekly", "monthly", "custom"]
          },
          targetAt: { type: "string", format: "date-time" }
        }
      },
      outputSchema: { type: "object", additionalProperties: true },
      execute: goalCreateExecute
    },
    {
      name: "goals.update",
      description: "Update an existing long-running goal.",
      permissionId: "goals.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "goals_management",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        required: ["goalId"],
        properties: {
          goalId: { type: "string" },
          title: { type: "string" },
          desiredOutcome: { type: "string" },
          status: {
            type: "string",
            enum: ["active", "paused", "blocked", "completed", "archived"]
          },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          reviewCadence: {
            type: "string",
            enum: ["none", "daily", "weekly", "biweekly", "monthly", "custom"]
          },
          targetAt: { type: "string", format: "date-time" }
        }
      },
      outputSchema: { type: "object", additionalProperties: true },
      execute: goalUpdateExecute
    },
    {
      name: "goals.addEvidence",
      description: "Add evidence (progress, context, etc) to a goal.",
      permissionId: "goals.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "goals_management",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        required: ["goalId", "evidenceKind", "sourceKind", "sourceLabel", "summary"],
        properties: {
          goalId: { type: "string" },
          evidenceKind: {
            type: "string",
            enum: [
              "context",
              "task",
              "status",
              "progress",
              "blocker",
              "decision",
              "checkpoint",
              "suggested_action"
            ]
          },
          sourceKind: {
            type: "string",
            enum: ["goal", "task", "note", "email", "calendar", "chat", "memory", "manual"]
          },
          sourceRef: { type: "string" },
          sourceLabel: { type: "string" },
          summary: { type: "string" },
          occurredAt: { type: "string", format: "date-time" }
        }
      },
      outputSchema: { type: "object", additionalProperties: true },
      execute: goalAddEvidenceExecute
    }
  ]
};
