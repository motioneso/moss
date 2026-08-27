import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  appGetMapSliceExecute,
  appGetMapSliceInputSchema,
  appGetMapSliceOutputSchema
} from "./app-map-tool.js";
import {
  localeOutputSchema,
  localeSetRegionAndDateFormatExecute,
  localeSetRegionAndDateFormatInputSchema,
  localeSetTimezoneExecute,
  localeSetTimezoneInputSchema
} from "./locale-tools.js";
import {
  notificationPreferenceSetEnabledExecute,
  notificationPreferenceSetEnabledInputSchema,
  notificationPreferenceSetEnabledOutputSchema
} from "./notification-preference-tool.js";
import {
  quietHoursOutputSchema,
  quietHoursSetExecute,
  quietHoursSetInputSchema
} from "./quiet-hours-tool.js";
import {
  themeModeSetExecute,
  themeModeSetInputSchema,
  themeModeSetOutputSchema
} from "./theme-mode-tool.js";
import {
  settingsUndoLastExecute,
  settingsUndoLastInputSchema,
  settingsUndoLastOutputSchema
} from "./undo-apply-tool.js";
import {
  weatherLocationOutputSchema,
  weatherLocationSetExecute,
  weatherLocationSetInputSchema
} from "./weather-location-tool.js";

export const settingsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const SETTINGS_MODULE_ID = "settings";

export const settingsModuleManifest: MossModuleManifest = {
  id: SETTINGS_MODULE_ID,
  name: "Settings",
  version: "0.0.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true
  },
  notifications: { supported: true },
  navigation: [
    {
      id: "settings",
      label: "Settings",
      description: "Open personal and instance settings.",
      path: "/settings",
      icon: "settings",
      order: 1000,
      permissionId: "settings.view"
    }
  ],
  settings: [
    {
      id: "priority-settings",
      label: "Priorities",
      description: "Tell your assistant which goals and commitments matter most.",
      path: "/settings?section=priorities",
      scope: "user",
      order: 30,
      permissionId: "settings.write"
    },
    {
      id: "admin-settings",
      label: "Admin",
      description: "Manage instance access, modules, AI providers, and host settings.",
      path: "/settings/admin",
      scope: "admin",
      order: 1000,
      permissionId: "settings.manage"
    }
  ],
  permissions: [
    {
      id: "settings.view",
      label: "View settings",
      description: "View personal settings surfaces.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "settings.write",
      label: "Edit personal settings",
      description: "Update personal settings (locale, quiet hours, persona, etc.).",
      scope: "user",
      actions: ["update"]
    },
    {
      id: "settings.manage",
      label: "Manage instance settings",
      description: "Manage users and instance-level settings.",
      scope: "admin",
      actions: ["manage"]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/bootstrap/status"
    },
    {
      method: "GET",
      path: "/api/me",
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/profile",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/locale",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/locale",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/quiet-hours",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/quiet-hours",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notification-preferences",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notification-preferences/:moduleId",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notification-digest-preference",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notification-digest-preference",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/weather-location",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/weather-location",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/weather-location/search",
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/weather-unit",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/weather-unit",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/themes",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/themes/active",
      permissionId: "settings.write"
    },
    {
      method: "PUT",
      path: "/api/me/themes/mode",
      permissionId: "settings.write"
    },
    {
      method: "PUT",
      path: "/api/me/themes/:id",
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/themes/:id",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notes-source",
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/notes-source/directories",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notes-source",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notes-last-sync",
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/sessions",
      permissionId: "settings.view"
    },
    {
      method: "DELETE",
      path: "/api/me/sessions/others",
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/sessions/:id",
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/account",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/persona",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/persona",
      permissionId: "settings.write"
    },
    {
      method: "POST",
      path: "/api/me/persona/preview",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/source-behaviors",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/source-behaviors/:id",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/priority-model",
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/priority-model",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/proactive-monitoring-settings",
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/proactive-monitoring-settings",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/admin/auth/providers",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/users",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/yolo",
      permissionId: "settings.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/yolo/instance",
      permissionId: "settings.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/yolo/users/:id",
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/admin/yolo/allow-all",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/settings",
      permissionId: "settings.manage"
    },
    {
      method: "PATCH",
      path: "/api/admin/settings/:key",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/runtime-config/:key",
      permissionId: "settings.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/runtime-config/:key",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/audit-events",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/modules",
      permissionId: "settings.manage"
    },
    {
      method: "PATCH",
      path: "/api/admin/modules/:id",
      permissionId: "settings.manage"
    },
    // #917: external-module admin surface. Admin-only (settings.manage), same as the
    // built-in module admin routes above.
    {
      method: "GET",
      path: "/api/admin/external-modules",
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/admin/external-modules/:id",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/me/modules",
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/modules/:id",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/yolo",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/yolo",
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/settings/me/data-export",
      permissionId: "settings.view"
    },
    {
      method: "POST",
      path: "/api/me/export",
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/export/status/:jobId",
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/export/download/:jobId",
      permissionId: "settings.view"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-check",
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-install",
      permissionId: "settings.manage"
    },
    // #342 Phase 3 (§L.5): the admin-gated provider-login routes (login presentation layer).
    {
      method: "POST",
      path: "/api/onboarding/provider-login/begin",
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-login/poll",
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-login/submit-token",
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-login/cancel",
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/me/chat-archive",
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/chat-archive",
      permissionId: "settings.write"
    }
  ],
  assistantActionFamilies: [
    {
      id: "settings.preference-write",
      label: "Settings preference changes",
      description: "Update personal app preferences such as color mode.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "app.getMapSlice",
      description:
        "Look up a bounded slice of the app's declared screens, settings, features, errors, and remediations. Supply at least one of screenId, settingId, errorCode, or query — a call with none of them is rejected.",
      permissionId: "settings.view",
      risk: "read",
      inputSchema: appGetMapSliceInputSchema,
      outputSchema: appGetMapSliceOutputSchema,
      execute: appGetMapSliceExecute
    },
    {
      name: "settings.themeMode.set",
      description: "Set the app's color mode (light or dark) for this user.",
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: themeModeSetInputSchema,
      outputSchema: themeModeSetOutputSchema,
      execute: themeModeSetExecute,
      affectsQueryKeys: ["settings.themes"]
    },
    {
      name: "settings.locale.setTimezone",
      description: "Set the user's IANA time zone.",
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: localeSetTimezoneInputSchema,
      outputSchema: localeOutputSchema,
      execute: localeSetTimezoneExecute
    },
    {
      name: "settings.locale.setRegionAndDateFormat",
      description: "Set the user's language/region and date format (12h or 24h).",
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: localeSetRegionAndDateFormatInputSchema,
      outputSchema: localeOutputSchema,
      execute: localeSetRegionAndDateFormatExecute
    },
    {
      name: "settings.quietHours.set",
      description: "Set the user's quiet hours (enabled, start/end time, and time zone).",
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: quietHoursSetInputSchema,
      outputSchema: quietHoursOutputSchema,
      execute: quietHoursSetExecute
    },
    {
      name: "settings.weatherLocation.set",
      description: "Save the user's weather location by resolving a place name.",
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: weatherLocationSetInputSchema,
      outputSchema: weatherLocationOutputSchema,
      execute: weatherLocationSetExecute
    },
    {
      name: "settings.notificationPreference.setEnabled",
      description:
        "Turn a module's notifications on or off for this user, optionally clearing its unread count.",
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      requiresServices: ["notificationPreferenceWrite"],
      inputSchema: notificationPreferenceSetEnabledInputSchema,
      outputSchema: notificationPreferenceSetEnabledOutputSchema,
      execute: notificationPreferenceSetEnabledExecute
    },
    {
      name: "settings.undoLast",
      description:
        'Undo the user\'s most recent settings preference change in this conversation (e.g. "change that back"). No-op if nothing tracked, or if the setting changed again since. Only remembers changes made earlier in this same chat session since the app last restarted — it does not track changes made in the settings UI, in a different conversation, or before a restart.',
      permissionId: "settings.write",
      risk: "write",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: settingsUndoLastInputSchema,
      outputSchema: settingsUndoLastOutputSchema,
      execute: settingsUndoLastExecute
    }
  ]
};
