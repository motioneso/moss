import { usefulnessFeedbackPresentation } from "./approval-presentation.js";
import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  createUsefulnessFeedbackRequestSchema,
  createUsefulnessFeedbackSignalRequestSchema,
  createUsefulnessFeedbackResponseSchema,
  listUsefulnessFeedbackResponseSchema,
  updateUsefulnessFeedbackReasonRequestSchema
} from "@moss/shared";

export const USEFULNESS_FEEDBACK_MODULE_ID = "usefulness-feedback";
export const usefulnessFeedbackModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const usefulnessFeedbackModuleManifest = {
  id: USEFULNESS_FEEDBACK_MODULE_ID,
  name: "Usefulness Feedback",
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
      "sql/0120_usefulness_feedback_signals.sql",
      "sql/0201_story_relevance_feedback.sql",
      "sql/0243_story_relevance_answer_cache.sql"
    ],
    migrationDirectories: ["packages/usefulness-feedback/sql"],
    ownedTables: [
      "app.usefulness_feedback_signals",
      "app.usefulness_feedback_targets",
      "app.story_relevance_answer_cache"
    ]
  },
  permissions: [
    {
      id: "usefulness-feedback.manage",
      label: "Manage usefulness feedback",
      description: "Create, list, edit, and undo usefulness feedback owned by the active actor.",
      scope: "user",
      actions: ["create", "view", "update"]
    }
  ],
  features: [
    {
      id: "usefulness-feedback.record-only",
      description:
        "Record usefulness signals for chat messages, briefings and proactive cards. Approval identifies the exact owned item. Signals do not remove tasks, create memories, dismiss cards or refresh feeds; unavailable targets cannot be approved.",
      errors: [
        {
          code: "usefulness-feedback.effectful-action",
          class: "validation",
          description:
            "This feedback action cannot be recorded through chat without its UI effects."
        }
      ]
    },
    {
      id: "usefulness-feedback.ui-actions",
      description:
        "Use the existing feedback menus to remove briefing follow-through, remember content, " +
        "dismiss proactive cards or change News and Sports preferences. Reason edits and undo " +
        "also stay in the UI because they can refresh a feed."
    }
  ],
  routes: [
    {
      method: "POST",
      path: "/api/me/usefulness-feedback/signals",
      chat: {
        access: "write",
        title: "Record a usefulness feedback signal",
        presentation: usefulnessFeedbackPresentation,
        content: "outside"
      },
      requestSchema: createUsefulnessFeedbackSignalRequestSchema,
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "POST",
      path: "/api/me/usefulness-feedback",
      chat: { access: "blocked", blockedBecause: "external_effect", content: "outside" },
      requestSchema: createUsefulnessFeedbackRequestSchema,
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "GET",
      path: "/api/me/usefulness-feedback",
      chat: { access: "read", content: "outside" },
      responseSchema: listUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "PATCH",
      path: "/api/me/usefulness-feedback/:id",
      chat: { access: "blocked", blockedBecause: "external_effect", content: "outside" },
      requestSchema: updateUsefulnessFeedbackReasonRequestSchema,
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "POST",
      path: "/api/me/usefulness-feedback/:id/undo",
      chat: { access: "blocked", blockedBecause: "external_effect", content: "outside" },
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    }
  ]
} satisfies MossModuleManifest;
