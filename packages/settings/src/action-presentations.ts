import { createHash } from "node:crypto";
import { assertDataContextDb } from "@moss/db";
import {
  approvalBoolean,
  approvalChoice,
  approvalNumber,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type ApprovalModuleReference,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { AESTHETIC_THEME_TOKEN_KEYS } from "@moss/shared";
import { normalizeCustomThemes } from "./themes-routes.js";
import { settingsUndoStack } from "./undo-stack.js";
import { isValidIanaTimeZone } from "./locale-tools.js";

const preferences = new PreferencesRepository();
const text = (label: string) => ({ label, present: approvalText });
const bool = (label: string) => ({ label, present: approvalBoolean });
const number = (label: string) => ({ label, present: approvalNumber });
const timezone = {
  label: "Time zone",
  present: (value: unknown) =>
    typeof value === "string" && isValidIanaTimeZone(value) ? value : null
};
const localeFields: ApprovalFieldMap = {
  timezone,
  region: text("Language and region"),
  dateFormat: {
    label: "Time format",
    present: approvalChoice({ "12": "12-hour", "24": "24-hour" })
  }
};
const time = (label: string) => ({
  label,
  present: (value: unknown) =>
    typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null
});
const quietFields: ApprovalFieldMap = {
  enabled: bool("Enabled"),
  start: time("Start"),
  end: time("End"),
  timezone: {
    label: "Time zone",
    present: (value) => (value === null ? "Use your time zone" : timezone.present(value))
  }
};

// Undo restores the whole Profile row, including whether it settles the alert schedule.
const quietUndoFields: ApprovalFieldMap = {
  ...quietFields,
  authority: {
    label: "Quiet hours source",
    present: approvalChoice({
      canonical: "Profile",
      unresolved: "Not settled: alerts keep their own schedule"
    })
  }
};
const modeFields: ApprovalFieldMap = {
  mode: { label: "Appearance", present: approvalChoice({ light: "Light", dark: "Dark" }) }
};
function simpleRoute(
  target: string,
  declarations: ApprovalFieldMap,
  required: readonly string[] = []
): RouteApprovalPresentation {
  return async (_db, input) => {
    if (Object.keys(input.params).length || Object.keys(input.query ?? {}).length) return null;
    const fields = presentApprovalFields(input.body, declarations, required);
    return fields ? { target, fields } : null;
  };
}
function simpleTool(
  target: string,
  declarations: ApprovalFieldMap,
  required: readonly string[] = []
): ToolApprovalPresentation {
  return async (_db, input) => {
    const fields = presentApprovalFields(input, declarations, required);
    return fields ? { target, fields } : null;
  };
}
export const localeRoutePresentation = simpleRoute(
  "Language, region and time zone",
  {
    locale: {
      label: "Locale",
      present: (value) =>
        presentApprovalFields(value, localeFields, ["timezone", "region", "dateFormat"])
    }
  },
  ["locale"]
);
export const quietRoutePresentation = simpleRoute(
  "Quiet hours",
  {
    quietHours: {
      label: "Quiet hours",
      present: (value) => presentApprovalFields(value, quietFields, ["enabled", "start", "end"])
    }
  },
  ["quietHours"]
);
export const modeRoutePresentation = simpleRoute("Appearance", modeFields, ["mode"]);
export const weatherUnitPresentation = simpleRoute(
  "Weather",
  {
    unit: {
      label: "Units",
      present: (value) =>
        value === "metric"
          ? [
              { label: "Temperature", value: "Celsius" },
              { label: "Wind speed", value: "Kilometres per hour" },
              { label: "Rainfall", value: "Millimetres" }
            ]
          : value === "imperial"
            ? [
                { label: "Temperature", value: "Fahrenheit" },
                { label: "Wind speed", value: "Miles per hour" },
                { label: "Rainfall", value: "Inches" }
              ]
            : null
    }
  },
  ["unit"]
);
export const weatherLocationPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || Object.keys(input.query ?? {}).length) return null;
  if (input.body === null)
    return { target: "Weather", fields: [{ label: "Location", value: "Remove saved location" }] };
  const fields = presentApprovalFields(
    input.body,
    { lat: number("Latitude"), lon: number("Longitude"), label: text("Location") },
    ["lat", "lon", "label"]
  );
  return fields ? { target: "Weather", fields } : null;
};
export const weatherSearchPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (input.body !== undefined || Object.keys(input.params).length) return null;
  const fields = presentApprovalFields(input.query, { query: text("Place to search") }, ["query"]);
  return fields ? { target: "Weather location search", fields } : null;
};
export const weatherReversePresentation: RouteApprovalPresentation = async (_db, input) => {
  if (input.body !== undefined || Object.keys(input.params).length) return null;
  const fields = presentApprovalFields(
    input.query,
    { lat: text("Latitude"), lon: text("Longitude") },
    ["lat", "lon"]
  );
  return fields ? { target: "Weather location search", fields } : null;
};
export const themeModePresentation = simpleTool("Appearance", modeFields, ["mode"]);
export const timezonePresentation = simpleTool("Language, region and time zone", { timezone }, [
  "timezone"
]);
export const regionPresentation = simpleTool(
  "Language, region and time zone",
  { region: localeFields.region!, dateFormat: localeFields.dateFormat! },
  ["region", "dateFormat"]
);
export const quietHoursPresentation = simpleTool("Quiet hours", quietFields, [
  "enabled",
  "start",
  "end"
]);
export const weatherPlacePresentation = simpleTool(
  "Weather",
  { query: text("Place to find and save") },
  ["query"]
);

const tokenLabels: Readonly<Record<string, string>> = {
  paper: "Page background",
  surface: "Surface",
  surface2: "Secondary surface",
  surface3: "Tertiary surface",
  ink: "Text",
  ink2: "Secondary text",
  ink3: "Quiet text",
  ink4: "Muted text",
  line: "Border",
  lineSubtle: "Subtle border",
  lineStrong: "Strong border",
  accent: "Accent",
  highlight: "Highlight",
  nav: "Navigation background",
  header: "Header background"
};
const tokenFields: ApprovalFieldMap = Object.fromEntries(
  Object.entries(tokenLabels).map(([key, label]) => [key, text(label)])
);
const version = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const deleteThemePresentation: RouteApprovalPresentation = async (_db, input) => {
  if (
    !input.target ||
    Object.keys(input.params).some((key) => key !== "id") ||
    Object.keys(input.query ?? {}).length
  )
    return null;
  const fields = presentApprovalFields(input.body, {});
  return fields ? { target: input.target, fields } : null;
};
export const activeThemePresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (Object.keys(input.params).length || Object.keys(input.query ?? {}).length) return null;
  const custom = normalizeCustomThemes(await preferences.get(db, "themes.custom"));
  const builtIn: Readonly<Record<string, string>> = {
    light: "Forest",
    sage: "Sage",
    canyon: "Canyon",
    teal: "Teal",
    dusk: "Dusk"
  };
  const fields = presentApprovalFields(
    input.body,
    {
      id: {
        label: "Theme",
        present: (value) =>
          typeof value === "string"
            ? (custom.find((theme) => theme.id === value)?.name ??
              (Object.hasOwn(builtIn, value) ? builtIn[value]! : null))
            : null
      }
    },
    ["id"]
  );
  const id = (input.body as { id?: string } | undefined)?.id;
  return fields
    ? {
        target: "Appearance",
        fields,
        version: version(custom.find((theme) => theme.id === id) ?? { id })
      }
    : null;
};
export const saveThemePresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (
    !input.params.id ||
    Object.keys(input.params).some((key) => key !== "id") ||
    Object.keys(input.query ?? {}).length
  )
    return null;
  const custom = normalizeCustomThemes(await preferences.get(db, "themes.custom"));
  const existing = custom.find((theme) => theme.id === input.params.id);
  const fields = presentApprovalFields(input.body, {
    name: text("Name"),
    tokens: { label: "Colors", present: (value) => presentApprovalFields(value, tokenFields) }
  });
  if (!fields) return null;
  const body = input.body as { name?: string; tokens?: Record<string, unknown> } | undefined;
  if (
    !existing &&
    (!body?.tokens || AESTHETIC_THEME_TOKEN_KEYS.some((key) => !Object.hasOwn(body.tokens!, key)))
  )
    return null;
  const target = existing?.name ?? body?.name ?? "Untitled theme";
  return { target, fields, version: version(existing ?? { id: input.params.id }) };
};
export const chatRetentionPresentation = simpleRoute(
  "Chat archive",
  { enabled: bool("Enabled"), folder: text("Archive folder") },
  ["enabled", "folder"]
);

const notificationFields: ApprovalFieldMap = {
  enabled: bool("Notifications enabled"),
  clearUnread: bool("Clear unread notifications")
};
export const notificationRoutePresentation: RouteApprovalPresentation = async (_db, input) => {
  if (
    Object.keys(input.params).some((key) => key !== "moduleId") ||
    Object.keys(input.query ?? {}).length
  )
    return null;
  const module = input.modules?.find(
    (entry) => entry.id === input.params.moduleId && entry.notificationsSupported
  );
  const fields = presentApprovalFields(input.body, notificationFields, ["enabled"]);
  return module && fields ? { target: module.name, fields, version: module.id } : null;
};
export const notificationToolPresentation: ToolApprovalPresentation = async (
  _db,
  input,
  _ctx,
  services
) => {
  const modules = services?.approvalModules as readonly ApprovalModuleReference[] | undefined;
  const module = modules?.find(
    (entry) => entry.id === input.moduleId && entry.notificationsSupported
  );
  if (!module) return null;
  const fields = presentApprovalFields(
    input,
    {
      ...notificationFields,
      moduleId: { label: "Module", present: (value) => (value === module.id ? module.name : null) }
    },
    ["moduleId", "enabled"]
  );
  return fields ? { target: module.name, fields, version: module.id } : null;
};
export const undoSettingsPresentation: ToolApprovalPresentation = async (
  _db,
  input,
  ctx,
  services
) => {
  if (!presentApprovalFields(input, {})) return null;
  const entry = settingsUndoStack.peek(ctx.actorUserId, ctx.chatSessionId);
  if (!entry)
    return {
      target: "Settings",
      fields: [{ label: "Change", value: "No settings change to undo" }]
    };
  let target: string;
  let fields: readonly { label: string; value: string }[] | null;
  if (entry.key === "themes.color-mode") {
    target = "Appearance";
    fields = presentApprovalFields({ mode: entry.previousValue }, modeFields);
  } else if (entry.key === "locale") {
    target = "Language, region and time zone";
    fields = presentApprovalFields(entry.previousValue, localeFields);
  } else if (entry.key === "quiet-hours") {
    target = "Quiet hours";
    fields = presentApprovalFields(entry.previousValue, quietUndoFields);
  } else if (entry.key === "weather-location") {
    target = "Weather";
    fields = presentApprovalFields(entry.previousValue, {
      lat: number("Latitude"),
      lon: number("Longitude"),
      label: text("Location")
    });
  } else if (entry.key.startsWith("notifications:")) {
    const modules = services?.approvalModules as readonly ApprovalModuleReference[] | undefined;
    const module = modules?.find((item) => item.id === entry.key.slice("notifications:".length));
    if (!module) return null;
    target = module.name;
    fields = presentApprovalFields(entry.previousValue, notificationFields);
  } else return null;
  if (entry.previousValue === null && entry.previousRevision === null)
    fields = [{ label: "Change", value: "Restore the default setting" }];
  return fields ? { target, fields, version: version(entry) } : null;
};
