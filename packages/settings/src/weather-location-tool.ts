import { randomUUID } from "node:crypto";

import { assertDataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import type { WeatherLocationDto } from "@moss/shared";

import { searchOpenMeteoLocations } from "@moss/weather";
import { settingsUndoStack } from "./undo-stack.js";

// Matches weather-location-routes.ts's WEATHER_LOCATION_PREFERENCE_KEY exactly.
const WEATHER_LOCATION_PREFERENCE_KEY = "weather-location";

const preferences = new PreferencesRepository();

export const weatherLocationSetInputSchema = {
  type: "object",
  properties: { query: { type: "string", minLength: 1 } },
  required: ["query"],
  additionalProperties: false
} as const;

export const weatherLocationOutputSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        status: { type: "string", enum: ["saved"] },
        lat: { type: "number" },
        lon: { type: "number" },
        label: { type: "string" }
      },
      required: ["status", "lat", "lon", "label"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ambiguous"] },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
              label: { type: "string" }
            },
            required: ["lat", "lon", "label"],
            additionalProperties: false
          }
        }
      },
      required: ["status", "candidates"],
      additionalProperties: false
    }
  ]
} as const;

export const weatherLocationSetExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { query } = input as { query: string };
  const candidates = await searchOpenMeteoLocations(query.trim());
  if (candidates.length === 0) throw new HttpError(404, "No weather location matched that place");
  if (candidates.length > 1) return { data: { status: "ambiguous", candidates } };

  const next: WeatherLocationDto = candidates[0]!;
  const current = await preferences.getWithRevision(scopedDb, WEATHER_LOCATION_PREFERENCE_KEY);
  const currentValue = current?.value as WeatherLocationDto | undefined;
  if (
    currentValue &&
    currentValue.lat === next.lat &&
    currentValue.lon === next.lon &&
    currentValue.label === next.label
  ) {
    return { data: { status: "saved", ...next } };
  }
  const written = await preferences.upsertWithRevision(
    scopedDb,
    WEATHER_LOCATION_PREFERENCE_KEY,
    next,
    current?.revision ?? null
  );
  settingsUndoStack.push(ctx.actorUserId, ctx.chatSessionId, {
    mutationId: randomUUID(),
    key: WEATHER_LOCATION_PREFERENCE_KEY,
    previousValue: current?.value ?? null,
    previousRevision: current?.revision ?? null,
    resultingRevision: written.revision,
    appliedAt: Date.now()
  });
  return { data: { status: "saved", ...next } };
};
