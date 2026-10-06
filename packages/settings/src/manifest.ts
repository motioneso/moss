import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import { customThemeTarget } from "./chat-targets.js";
import {
  appGetMapSliceExecute,
  appGetMapSliceInputSchema,
  appGetMapSliceOutputSchema
} from "./app-map-tool.js";
import {
  platformDiagnosticsExecute,
  platformDiagnosticsInputSchema,
  platformDiagnosticsOutputSchema
} from "./platform-diagnostics-tool.js";
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
      path: "/api/bootstrap/status",
      chat: { access: "read" }
    },
    {
      method: "GET",
      path: "/api/me",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/profile",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/locale",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/locale",
      chat: {
        access: "write",
        title: "Change your language, region and time zone",
        content: "user_authored"
      },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/quiet-hours",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/quiet-hours",
      chat: {
        access: "write",
        title: "Change your quiet hours",
        content: "user_authored",
        coveredBy: "settings.quietHours.set"
      },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notification-preferences",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notification-preferences/:moduleId",
      chat: {
        access: "write",
        title: "Turn a module's notifications on or off",
        content: "user_authored",
        coveredBy: "settings.notificationPreference.setEnabled"
      },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notification-digest-preference",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notification-digest-preference",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/weather-location",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/weather-location",
      chat: {
        access: "write",
        title: "Change your weather location",
        content: "user_authored",
        coveredBy: "settings.weatherLocation.set"
      },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/weather-location/search",
      chat: { access: "read", outbound: true },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/weather-location/reverse",
      chat: { access: "read", outbound: true },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/weather-unit",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/weather-unit",
      chat: { access: "write", title: "Change your weather units", content: "user_authored" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/themes",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/themes/active",
      chat: { access: "write", title: "Switch your theme", content: "user_authored" },
      permissionId: "settings.write"
    },
    {
      method: "PUT",
      path: "/api/me/themes/mode",
      chat: {
        access: "write",
        title: "Switch between light and dark mode",
        content: "user_authored",
        coveredBy: "settings.themeMode.set"
      },
      permissionId: "settings.write"
    },
    {
      method: "PUT",
      path: "/api/me/themes/:id",
      chat: { access: "write", title: "Save a custom theme", content: "user_authored" },
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/themes/:id",
      chat: {
        access: "destructive",
        title: "Delete a custom theme",
        content: "user_authored",
        target: customThemeTarget
      },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notes-source",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/notes-source/directories",
      chat: { access: "read" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notes-source",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notes-last-sync",
      chat: { access: "read" },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/sessions",
      chat: { access: "read" },
      permissionId: "settings.view"
    },
    {
      method: "DELETE",
      path: "/api/me/sessions/others",
      chat: { access: "blocked", blockedBecause: "identity_auth_registration" },
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/sessions/:id",
      chat: { access: "blocked", blockedBecause: "identity_auth_registration" },
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/account",
      chat: { access: "blocked", blockedBecause: "identity_auth_registration" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/persona",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/install-manifest",
      chat: { access: "read" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/persona",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.write"
    },
    {
      method: "POST",
      path: "/api/me/persona/preview",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/source-behaviors",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/source-behaviors/:id",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/priority-model",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/priority-model",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/proactive-monitoring-settings",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/proactive-monitoring-settings",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/admin/auth/providers",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/users",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/yolo",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/yolo/instance",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/yolo/users/:id",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/admin/yolo/allow-all",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/settings",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "PATCH",
      path: "/api/admin/settings/:key",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/runtime-config/:key",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/runtime-config/:key",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/audit-events",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/admin/modules",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "PATCH",
      path: "/api/admin/modules/:id",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    // #917: external-module admin surface. Admin-only (settings.manage), same as the
    // built-in module admin routes above.
    {
      method: "GET",
      path: "/api/admin/external-modules",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/admin/external-modules/:id",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/me/modules",
      chat: { access: "read" },
      permissionId: "settings.view"
    },
    {
      method: "PATCH",
      path: "/api/me/modules/:id",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/yolo",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/yolo",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/settings/me/data-export",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      permissionId: "settings.view"
    },
    {
      method: "POST",
      path: "/api/me/export",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/export/status/:jobId",
      chat: { access: "read" },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/export/download/:jobId",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      permissionId: "settings.view"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-check",
      chat: { access: "blocked", blockedBecause: "identity_auth_registration" },
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-install",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "settings.manage"
    },
    // #342 Phase 3 (§L.5): the admin-gated provider-login routes (login presentation layer).
    {
      method: "POST",
      path: "/api/onboarding/provider-login/begin",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-login/poll",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-login/submit-token",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "settings.manage"
    },
    {
      method: "POST",
      path: "/api/onboarding/provider-login/cancel",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "settings.manage"
    },
    {
      method: "GET",
      path: "/api/me/chat-archive",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/chat-archive",
      chat: { access: "write", title: "Change how long chats are kept", content: "user_authored" },
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
      name: "settings.platformDiagnostics",
      description:
        "Inspect bounded platform health and actor-scoped operational observations. Source provenance is returned only when requested and is limited to safe relative excerpts.",
      permissionId: "settings.view",
      risk: "read",
      inputSchema: platformDiagnosticsInputSchema,
      outputSchema: platformDiagnosticsOutputSchema,
      execute: platformDiagnosticsExecute
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
