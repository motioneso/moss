import { putWeatherUnitRouteSchema } from "@moss/shared";
import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  localeRoutePresentation,
  quietRoutePresentation,
  modeRoutePresentation,
  weatherUnitPresentation,
  weatherLocationPresentation,
  weatherSearchPresentation,
  weatherReversePresentation,
  deleteThemePresentation,
  activeThemePresentation,
  saveThemePresentation,
  chatRetentionPresentation,
  themeModePresentation,
  timezonePresentation,
  regionPresentation,
  quietHoursPresentation,
  weatherPlacePresentation,
  notificationRoutePresentation,
  notificationToolPresentation,
  undoSettingsPresentation
} from "./action-presentations.js";
import { customThemeTarget } from "./chat-targets.js";
import {
  appCallActionExecute,
  appCallActionInputSchema,
  appCallActionOutputSchema,
  appFindActionExecute,
  appFindActionInputSchema,
  appFindActionOutputSchema,
  appReadSourceExecute,
  appReadSourceInputSchema,
  appReadSourceOutputSchema
} from "./app-action-tools.js";
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
  chatDefaults: { presentationContent: "user_authored" },
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
  chatRefreshTokens: [
    "auth.me",
    "weather.today",
    "weather.location",
    "weather.unit",
    "modules",
    "myModules"
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
        presentation: localeRoutePresentation,
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
        presentation: quietRoutePresentation,
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
        presentation: notificationRoutePresentation,
        content: "user_authored",
        coveredBy: "settings.notificationPreference.setEnabled"
      },
      permissionId: "settings.write"
    },
    {
      method: "GET",
      path: "/api/me/notification-sensitivity",
      chat: { access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/notification-sensitivity",
      chat: { access: "blocked", blockedBecause: "external_effect" },
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
        presentation: weatherLocationPresentation,
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
      chat: {
        access: "read",
        outbound: true,
        title: "Find weather location",
        presentation: weatherSearchPresentation
      },
      permissionId: "settings.view"
    },
    {
      method: "GET",
      path: "/api/me/weather-location/reverse",
      chat: {
        access: "read",
        outbound: true,
        title: "Find weather location",
        presentation: weatherReversePresentation
      },
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
      requestSchema: putWeatherUnitRouteSchema.body,
      chat: {
        presentation: weatherUnitPresentation,
        access: "write",
        title: "Change your weather units",
        content: "user_authored"
      },
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
      chat: {
        presentation: activeThemePresentation,
        access: "write",
        title: "Switch your theme",
        content: "user_authored"
      },
      permissionId: "settings.write"
    },
    {
      method: "PUT",
      path: "/api/me/themes/mode",
      chat: {
        presentation: modeRoutePresentation,
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
      chat: {
        presentation: saveThemePresentation,
        access: "write",
        title: "Save a custom theme",
        content: "user_authored"
      },
      permissionId: "settings.write"
    },
    {
      method: "DELETE",
      path: "/api/me/themes/:id",
      chat: {
        access: "destructive",
        title: "Delete a custom theme",
        content: "user_authored",
        target: customThemeTarget,
        presentation: deleteThemePresentation
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
      chat: { presentation: chatRetentionPresentation, access: "read", content: "user_authored" },
      permissionId: "settings.view"
    },
    {
      method: "PUT",
      path: "/api/me/chat-archive",
      chat: {
        presentation: chatRetentionPresentation,
        access: "write",
        title: "Change chat archive settings",
        content: "user_authored"
      },
      permissionId: "settings.write"
    }
  ],
  features: [
    {
      id: "app.findAction",
      description:
        "Find declared app routes by plain words, including their input schemas, blocked categories and existing dedicated tools.",
      errors: [
        {
          code: "not_ready",
          class: "transient",
          description: "The app action catalog or service is not ready."
        },
        {
          code: "invalid_input",
          class: "validation",
          description: "An app tool input has an invalid query, method, path or line range."
        }
      ],
      remediations: [
        {
          id: "app.retry_action",
          description: "Open chat from Today and retry after the app has finished starting.",
          path: "/today"
        },
        {
          id: "app.correct_input",
          description:
            "Use the discovered action schema or correct the source path and line range, then retry in chat.",
          path: "/today"
        }
      ]
    },
    {
      id: "app.readSource",
      description:
        "Read up to 400 lines of installed public app source under packages/*/src or apps/*/src, limited to .ts, .tsx, .json and .md files.",
      errors: [
        {
          code: "source_path_not_allowed",
          class: "permission",
          description:
            "The source path leaves the permitted roots, resolves through an escaping symlink, or has a disallowed file type."
        },
        {
          code: "source_unavailable",
          class: "prerequisite",
          description: "The installed source root or requested source file cannot be read.",
          remediationRef: "app.source_path"
        }
      ],
      remediations: [
        {
          id: "app.source_path",
          description:
            "Use an existing relative source file under packages/*/src or apps/*/src with a supported extension, or rely on the action schema.",
          path: "/today"
        }
      ]
    },
    {
      id: "app.outsideContentApproval",
      description:
        "Outside results, forwarded errors, recall, attachments and outside-agent launch make writes ask, even in YOLO. Public app source, app-map reads and simple saved-setting acknowledgements do not add outside content."
    },
    {
      id: "app.ownerToolDescriptors",
      description:
        "Listing tools from integrations you connected or current add-on installations you explicitly approved does not add outside content. Unknown or other-owner descriptions still do. Outside results and forwarded errors still taint."
    },
    {
      id: "app.addonDescriptorApproval",
      description:
        "To approve an older add-on's tool descriptions for your chats, switch it off and on in Instance modules. While off, it is hidden for everyone. The personal module switch does not approve it."
    },
    {
      id: "app.callAction",
      description:
        "Call app routes as you. Destructive actions ask. After outside content enters a chat, writes and outbound reads ask, including in YOLO mode. Missing provenance also asks. Successful changes refresh screens.",
      errors: [
        {
          code: "context_admission_unavailable",
          class: "transient",
          description:
            "Outside content was withheld because conversation provenance could not be recorded or an automatic action is pending. Wait for pending actions or start a new chat; check any action result before retrying."
        },
        {
          code: "unknown_route",
          class: "validation",
          description: "No declared app action matches the method and path."
        },
        {
          code: "not_ready",
          class: "transient",
          description: "The action catalog or final permission check is unavailable."
        },
        {
          code: "blocked",
          class: "permission",
          description:
            "The route is outside the assistant's allowed actions, including admin and security-sensitive settings."
        },
        {
          code: "consent_off",
          class: "permission",
          description: "The module's AI consent is off, so its route cannot be called from chat."
        },
        {
          code: "approval_changed",
          class: "validation",
          description: "The action policy or target changed after review."
        },
        {
          code: "invalid_call_binding",
          class: "permission",
          description: "An action execution no longer matches the single reviewed call."
        }
      ],
      remediations: [
        {
          id: "app.retry_after_content_admission",
          description:
            "Wait for pending actions or start a new chat. If an action ran, check its result in the module before retrying.",
          path: "/today"
        },
        {
          id: "app.retry_ready_action",
          description: "Wait for the app to finish loading, then find and review the action again.",
          path: "/today"
        },
        {
          id: "app.find_available_action",
          description:
            "Find the action again and request a fresh review with its current inputs and target.",
          path: "/today"
        },
        {
          id: "app.use_settings",
          description:
            "Open the relevant module or setting to review consent or perform an action unavailable in chat.",
          path: "/settings"
        }
      ]
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
      name: "app.findAction",
      description:
        'Find how to change or do anything in the app: settings, preferences, themes, views, units, notifications, projects, any screen or button. Search plain words, such as "weather units". Returns routes, input shapes, blocked reasons and dedicated tools; prefer the dedicated tool named in coveredBy. Run the result with app.callAction.',
      permissionId: "settings.view",
      risk: "read",
      content: "user_authored",
      safeErrors: true,
      requiresServices: ["appCatalog"],
      inputSchema: appFindActionInputSchema,
      outputSchema: appFindActionOutputSchema,
      execute: appFindActionExecute
    },
    {
      name: "app.readSource",
      description:
        "Read installed app source when an action's input shape is missing. Use a relative packages/*/src or apps/*/src path ending .ts, .tsx, .json or .md. Returns at most 400 lines; line numbers are inclusive.",
      permissionId: "settings.view",
      risk: "read",
      content: "user_authored",
      safeErrors: true,
      inputSchema: appReadSourceInputSchema,
      outputSchema: appReadSourceOutputSchema,
      execute: appReadSourceExecute
    },
    {
      name: "app.callAction",
      description:
        "Do it in the app for the user: change, set, switch, update, turn on or off, rename, mark read, accept, create or apply anything app.findAction found. Runs as the signed-in user. Fill path parameters in path; send query and body separately. Blocked routes are refused, consent is checked, and destructive actions require approval. Returns HTTP status and body.",
      permissionId: "settings.write",
      safeErrors: true,
      risk: "write",
      selfOperationGrant: "confirm_always",
      executionPolicy: "confirm",
      requiresServices: ["appActions"],
      inputSchema: appCallActionInputSchema,
      outputSchema: appCallActionOutputSchema,
      execute: appCallActionExecute
    },
    {
      name: "app.getMapSlice",
      description:
        "Look up a bounded slice of the app's declared screens, settings, features, errors, and remediations. Supply at least one of screenId, settingId, errorCode, or query — a call with none of them is rejected.",
      permissionId: "settings.view",
      risk: "read",
      content: "user_authored",
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
      content: "outside",
      inputSchema: platformDiagnosticsInputSchema,
      outputSchema: platformDiagnosticsOutputSchema,
      execute: platformDiagnosticsExecute
    },
    {
      name: "settings.themeMode.set",
      actionLabel: "Change appearance",
      approvalPresentation: themeModePresentation,
      approvalContent: "user_authored",
      description: "Set the app's color mode (light or dark) for this user.",
      permissionId: "settings.write",
      risk: "write",
      content: "user_authored",
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
      actionLabel: "Change time zone",
      approvalPresentation: timezonePresentation,
      approvalContent: "user_authored",
      description: "Set the user's IANA time zone.",
      permissionId: "settings.write",
      risk: "write",
      content: "user_authored",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: localeSetTimezoneInputSchema,
      outputSchema: localeOutputSchema,
      execute: localeSetTimezoneExecute
    },
    {
      name: "settings.locale.setRegionAndDateFormat",
      actionLabel: "Change language and time format",
      approvalPresentation: regionPresentation,
      approvalContent: "user_authored",
      description: "Set the user's language/region and date format (12h or 24h).",
      permissionId: "settings.write",
      risk: "write",
      content: "user_authored",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: localeSetRegionAndDateFormatInputSchema,
      outputSchema: localeOutputSchema,
      execute: localeSetRegionAndDateFormatExecute
    },
    {
      name: "settings.quietHours.set",
      actionLabel: "Change quiet hours",
      approvalPresentation: quietHoursPresentation,
      approvalContent: "user_authored",
      description: "Set the user's quiet hours (enabled, start/end time, and time zone).",
      permissionId: "settings.write",
      risk: "write",
      content: "user_authored",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: quietHoursSetInputSchema,
      outputSchema: quietHoursOutputSchema,
      execute: quietHoursSetExecute
    },
    {
      name: "settings.weatherLocation.set",
      actionLabel: "Change weather location",
      approvalPresentation: weatherPlacePresentation,
      approvalContent: "user_authored",
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
      actionLabel: "Change notifications",
      approvalPresentation: notificationToolPresentation,
      approvalContent: "user_authored",
      description:
        "Turn a module's notifications on or off for this user, optionally clearing its unread count.",
      permissionId: "settings.write",
      risk: "write",
      content: "user_authored",
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
      actionLabel: "Undo last settings change",
      approvalPresentation: undoSettingsPresentation,
      approvalContent: "user_authored",
      description:
        'Undo the user\'s most recent settings preference change in this conversation (e.g. "change that back"). No-op if nothing tracked, or if the setting changed again since. Only remembers changes made earlier in this same chat session since the app last restarted — it does not track changes made in the settings UI, in a different conversation, or before a restart.',
      permissionId: "settings.write",
      risk: "write",
      content: "user_authored",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "settings.preference-write",
      executionPolicy: "auto",
      inputSchema: settingsUndoLastInputSchema,
      outputSchema: settingsUndoLastOutputSchema,
      execute: settingsUndoLastExecute
    }
  ]
};
