import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  deletePushSubscriptionResponseSchema,
  listNotificationsResponseSchema,
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema,
  pushConfigResponseSchema,
  registerPushSubscriptionResponseSchema
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
 * - V1 covered no external delivery. #743 / #2227 add opt-in web push as a second, additive
 *   delivery surface (fan-out only, never a replacement): the in-app bell + the GET
 *   /api/notifications route + the `notifications.listVisible` assistant tool remain the
 *   baseline, and a user can additionally register this browser for push notifications from
 *   Settings → Notifications. See `docs/superpowers/specs/2026-09-04-743-web-push-notifications.md`.
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
      "sql/0223_push_notifications.sql"
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
  settings: [
    {
      id: "notifications.push",
      label: "Push notifications",
      description:
        "Turn on push notifications for this browser and manage which devices receive them. " +
        "Needs a secure connection, is not available in every browser, and each person can " +
        "register up to 10 devices.",
      path: "/settings?section=modules&module=notifications",
      scope: "user",
      permissionId: "notifications.update"
    }
  ],
  features: [
    {
      id: "notifications.push",
      description:
        "Push notifications alert a registered browser or device, alongside the in-app bell. " +
        "Needs a secure connection, is not supported everywhere, and allows up to 10 devices " +
        "per person. A repeatedly-failing device is turned off but stays listed.",
      remediations: [
        {
          id: "notifications.push.manage_devices",
          description:
            "Remove push devices no longer in use, or turn push back on for a device, under " +
            "Push notifications in Settings.",
          path: "/settings?section=modules&module=notifications"
        },
        {
          id: "notifications.push.use_supported_browser",
          description:
            "Open the site over a secure (https) connection in a browser that supports push " +
            "notifications, then check Push notifications in Settings again.",
          path: "/settings?section=modules&module=notifications"
        }
      ],
      errors: [
        {
          code: "push_unsupported",
          class: "prerequisite",
          remediationRef: "notifications.push.use_supported_browser",
          description:
            "Shown as 'Not available here': this browser does not support push notifications, " +
            "or the page was not loaded over a secure connection."
        },
        {
          code: "push_permission_denied",
          class: "permission",
          description:
            "Shown as 'Blocked in this browser's site settings': the user previously refused " +
            "the browser's notification permission prompt. Allow notifications for this site " +
            "in the browser's own settings, then reload the page."
        },
        {
          code: "push_device_limit",
          class: "validation",
          description:
            "Registering a new device was refused because this person already has 10 " +
            "registered devices, the most allowed. Remove a device that is no longer used, " +
            "then try again."
        },
        {
          code: "push_device_disabled",
          class: "transient",
          description:
            "Shown next to a device as 'Turned off after repeated delivery failures': " +
            "delivery failed five times in a row, so the device stopped receiving push. " +
            "Remove it, or turn push back on for that same device to start again."
        }
      ]
    }
  ],
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
      label: "Update notifications",
      description:
        "Mark notifications read for the active actor, and register or remove that actor's " +
        "push notification devices.",
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
    },
    {
      method: "GET",
      path: "/api/notifications/push/config",
      responseSchema: pushConfigResponseSchema,
      permissionId: "notifications.view"
    },
    {
      method: "POST",
      path: "/api/notifications/push/subscriptions",
      responseSchema: registerPushSubscriptionResponseSchema,
      permissionId: "notifications.update"
    },
    {
      method: "DELETE",
      path: "/api/notifications/push/subscriptions/:id",
      responseSchema: deletePushSubscriptionResponseSchema,
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
