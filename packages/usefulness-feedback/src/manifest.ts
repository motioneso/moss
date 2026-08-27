import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  createUsefulnessFeedbackRequestSchema,
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
      "sql/0201_story_relevance_feedback.sql"
    ],
    migrationDirectories: ["packages/usefulness-feedback/sql"],
    ownedTables: ["app.usefulness_feedback_signals", "app.usefulness_feedback_targets"]
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
  routes: [
    {
      method: "POST",
      path: "/api/me/usefulness-feedback",
      requestSchema: createUsefulnessFeedbackRequestSchema,
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "GET",
      path: "/api/me/usefulness-feedback",
      responseSchema: listUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "PATCH",
      path: "/api/me/usefulness-feedback/:id",
      requestSchema: updateUsefulnessFeedbackReasonRequestSchema,
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    },
    {
      method: "POST",
      path: "/api/me/usefulness-feedback/:id/undo",
      responseSchema: createUsefulnessFeedbackResponseSchema,
      permissionId: "usefulness-feedback.manage"
    }
  ]
} satisfies MossModuleManifest;
