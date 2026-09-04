import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  listNotificationsResponseSchema,
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema
} from "@moss/shared";

import { notificationsListVisibleExecute } from "./tools.js";

/**
 * Notifications V1 — delivery model (LOCKED, see spec
 * 2026-06-19-notifications-actor-scoped-hardening.md).
 *
 * - V1 is **in-app, actor-scoped delivery**. `app.notifications.recipient_user_id` is
 *   always `app.current_actor_user_id()`, set by the active actor's `DataContextRunner`
 *   scope. `assertDataContextDb` is the gate.
 * - App and worker code may create notifications **only inside the active actor's
 *   `DataContextRunner` scope**; there is no system-emitter / NULL-`actor_user_id`
 *   producer path in V1. The repository API exposes no recipient/actor override.
 * - It is **not** a generic cross-user or system-broadcast mechanism. There is no
 *   "share", "broadcast", or "send-to" surface.
 * - V1 covers **no** external push / email / SMS delivery. The only delivery surface is
 *   the in-app bell + the GET /api/notifications route + the
 *   `notifications.listVisible` assistant tool.
 * - The briefings worker is the reference producer path (see
 *   `packages/briefings/src/jobs.ts`): it calls `NotificationsRepository.create`
 *   inside `withDataContext` with a metadata-only payload.
 *
 * Information-egress non-goals: `metadata` is bounded (16 keys, primitive values,
 * ≤256-char strings, ≤4096 bytes) and re-projected at the `serializeNotification`
 * chokepoint before any client exposure (REST or assistant tool). The route handler
 * answers `404 Notification not found` for BOTH absent and RLS-invisible ids — the
 * two cases are intentionally indistinguishable so callers cannot probe for existence.
 */
export const NOTIFICATIONS_MODULE_ID = "notifications";
export const notificationsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const notificationsModuleManifest = {
  id: NOTIFICATIONS_MODULE_ID,
  name: "Notifications",
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
      "sql/0008_notifications_module.sql",
      "sql/0071_notifications_worker_insert_grant.sql",
      "sql/0101_notifications_metadata_size_check.sql",
      "sql/0102_notifications_defense_in_depth_comments.sql",
      "sql/0142_notifications_module_id.sql",
      "sql/0214_push_notifications.sql"
    ],
    migrationDirectories: ["packages/notifications/sql"],
    ownedTables: [
      "app.notifications",
      "app.notification_reads",
      "app.push_subscriptions",
      "app.push_signing_key"
    ]
  },
  // No sidebar nav entry: notifications are reached via the topbar bell (AppShell), which
  // links to /notifications and shows the unread badge. The route + APIs remain registered.
  navigation: [],
  permissions: [
    {
      id: "notifications.view",
      label: "View notifications",
      description: "Read notifications delivered to the active actor.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "notifications.update",
      label: "Update notification read state",
      description: "Mark notifications read for the active actor.",
      scope: "user",
      actions: ["update"]
    },
    {
      id: "notifications.manage",
      label: "Manage notifications module",
      description: "Manage notification module settings and delivery behavior.",
      scope: "system",
      actions: ["manage"]
    }
  ],
  featureFlags: [
    {
      id: "notifications.module",
      label: "Notifications module",
      description: "Enables the built-in in-app Notifications module surfaces and routes.",
      scope: "system",
      defaultEnabled: true
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/notifications",
      responseSchema: listNotificationsResponseSchema,
      permissionId: "notifications.view"
    },
    {
      method: "PATCH",
      path: "/api/notifications/:id/read",
      responseSchema: markNotificationReadResponseSchema,
      permissionId: "notifications.update"
    },
    {
      method: "PATCH",
      path: "/api/notifications/read-all",
      responseSchema: markAllNotificationsReadResponseSchema,
      permissionId: "notifications.update"
    }
  ],
  assistantTools: [
    {
      name: "notifications.listVisible",
      description: "List notifications delivered to the active actor.",
      permissionId: "notifications.view",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {}
      },
      outputSchema: listNotificationsResponseSchema,
      execute: notificationsListVisibleExecute
    }
  ]
} satisfies MossModuleManifest;
