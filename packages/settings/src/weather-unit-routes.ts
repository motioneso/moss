import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  getWeatherUnitRouteSchema,
  putWeatherUnitRouteSchema,
  type PutWeatherUnitRequest,
  type WeatherUnit,
  type WeatherUnitDto
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import type { ProfilePreferencesPort } from "./preferences-port.js";
import { handleSettingsRouteError } from "./route-error.js";

const WEATHER_UNIT_PREFERENCE_KEY = "weather-unit";
const DEFAULT_WEATHER_UNIT: WeatherUnit = "imperial";

interface WeatherUnitRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: ProfilePreferencesPort;
}

export function registerWeatherUnitRoutes(
  server: FastifyInstance,
  dependencies: WeatherUnitRoutesDependencies
): void {
  server.get(
    "/api/me/weather-unit",
    { schema: getWeatherUnitRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const raw = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.preferencesRepository.get(scopedDb, WEATHER_UNIT_PREFERENCE_KEY)
        );
        return { unit: normalizeWeatherUnit(raw) } satisfies WeatherUnitDto;
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/me/weather-unit",
    { schema: putWeatherUnitRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as PutWeatherUnitRequest;
        const unit = sanitizeWeatherUnit(body.unit);
        await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.preferencesRepository.upsert(scopedDb, WEATHER_UNIT_PREFERENCE_KEY, unit)
        );
        return { unit } satisfies WeatherUnitDto;
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}

function normalizeWeatherUnit(value: unknown): WeatherUnit {
  return value === "metric" || value === "imperial" ? value : DEFAULT_WEATHER_UNIT;
}

function sanitizeWeatherUnit(value: unknown): WeatherUnit {
  if (value !== "metric" && value !== "imperial") {
    throw new HttpError(400, "unit must be metric or imperial");
  }
  return value;
}
