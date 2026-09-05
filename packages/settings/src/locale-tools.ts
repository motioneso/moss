import { randomUUID } from "node:crypto";

import { assertDataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import {
  DEFAULT_LOCALE_SETTINGS,
  type LocaleDateFormat,
  type LocaleSettingsDto
} from "@moss/shared";

import { settingsUndoStack } from "./undo-stack.js";

// Matches locale-routes.ts's LOCALE_PREFERENCE_KEY exactly — both read/write the same preference row.
const LOCALE_PREFERENCE_KEY = "locale";

const preferences = new PreferencesRepository();

export function isValidIanaTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readCurrentLocale(raw: unknown): LocaleSettingsDto {
  if (!raw || typeof raw !== "object") return DEFAULT_LOCALE_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    timezone: typeof r.timezone === "string" ? r.timezone : DEFAULT_LOCALE_SETTINGS.timezone,
    region: typeof r.region === "string" ? r.region : DEFAULT_LOCALE_SETTINGS.region,
    dateFormat:
      r.dateFormat === "12" || r.dateFormat === "24"
        ? (r.dateFormat as LocaleDateFormat)
        : DEFAULT_LOCALE_SETTINGS.dateFormat
  };
}

export const localeSetTimezoneInputSchema = {
  type: "object",
  properties: { timezone: { type: "string", minLength: 1, maxLength: 100 } },
  required: ["timezone"],
  additionalProperties: false
} as const;

export const localeOutputSchema = {
  type: "object",
  properties: {
    timezone: { type: "string" },
    region: { type: "string" },
    dateFormat: { type: "string", enum: ["12", "24"] }
  },
  required: ["timezone", "region", "dateFormat"],
  additionalProperties: false
} as const;

export const localeSetTimezoneExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { timezone } = input as { timezone: string };
  if (!isValidIanaTimeZone(timezone)) {
    throw new HttpError(400, "Not a recognized time zone");
  }
  const current = await preferences.getWithRevision(scopedDb, LOCALE_PREFERENCE_KEY);
  const normalizedCurrent = readCurrentLocale(current?.value);
  if (current && normalizedCurrent.timezone === timezone) {
    return { data: { ...normalizedCurrent } };
  }
  const next: LocaleSettingsDto = { ...normalizedCurrent, timezone };
  const written = await preferences.upsertWithRevision(
    scopedDb,
    LOCALE_PREFERENCE_KEY,
    next,
    current?.revision ?? null
  );
  settingsUndoStack.push(ctx.actorUserId, ctx.chatSessionId, {
    mutationId: randomUUID(),
    key: LOCALE_PREFERENCE_KEY,
    previousValue: current?.value ?? null,
    previousRevision: current?.revision ?? null,
    resultingRevision: written.revision,
    appliedAt: Date.now()
  });
  return { data: { ...next } };
};

export const localeSetRegionAndDateFormatInputSchema = {
  type: "object",
  properties: {
    region: { type: "string", minLength: 1, maxLength: 35 },
    dateFormat: { type: "string", enum: ["12", "24"] }
  },
  required: ["region", "dateFormat"],
  additionalProperties: false
} as const;

export const localeSetRegionAndDateFormatExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { region: rawRegion, dateFormat } = input as {
    region: string;
    dateFormat: LocaleDateFormat;
  };
  const region = rawRegion.trim();
  if (region.length === 0) {
    throw new HttpError(400, "Language and region is required");
  }
  const current = await preferences.getWithRevision(scopedDb, LOCALE_PREFERENCE_KEY);
  const normalizedCurrent = readCurrentLocale(current?.value);
  if (
    current &&
    normalizedCurrent.region === region &&
    normalizedCurrent.dateFormat === dateFormat
  ) {
    return { data: { ...normalizedCurrent } };
  }
  const next: LocaleSettingsDto = { ...normalizedCurrent, region, dateFormat };
  const written = await preferences.upsertWithRevision(
    scopedDb,
    LOCALE_PREFERENCE_KEY,
    next,
    current?.revision ?? null
  );
  settingsUndoStack.push(ctx.actorUserId, ctx.chatSessionId, {
    mutationId: randomUUID(),
    key: LOCALE_PREFERENCE_KEY,
    previousValue: current?.value ?? null,
    previousRevision: current?.revision ?? null,
    resultingRevision: written.revision,
    appliedAt: Date.now()
  });
  return { data: { ...next } };
};
