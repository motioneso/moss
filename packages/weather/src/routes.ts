import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import {
  getWeatherTodayRouteSchema,
  getWeatherForecastRouteSchema,
  type WeatherForecastQuery,
  LOCALE_PREFERENCE_KEY,
  resolveEffectiveLocale
} from "@moss/shared";
import { WeatherService } from "./weather-service.js";

import { WeatherForecastReader } from "./forecast/reader.js";
import { configureWeatherForecastRead } from "./forecast/tool.js";

interface WeatherRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepo: PreferencesPort;
  readonly logger: FastifyBaseLogger;
  readonly fetchFn?: typeof fetch;
}

/**
 * The person's saved locale timezone, or null when none is saved. The zone only picks a fallback
 * city, so the shared default zone must never stand in for one (#3395).
 */
async function savedTimeZone(
  dependencies: WeatherRoutesDependencies,
  accessContext: AccessContext
): Promise<string | null> {
  const stored = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
    dependencies.preferencesRepo.get(scopedDb, LOCALE_PREFERENCE_KEY)
  );
  const saved =
    stored !== null &&
    typeof stored === "object" &&
    typeof (stored as { timezone?: unknown }).timezone === "string";
  return saved ? resolveEffectiveLocale(stored).timezone : null;
}

export function registerWeatherRoutes(
  server: FastifyInstance,
  dependencies: WeatherRoutesDependencies
): void {
  const service = new WeatherService({
    preferencesRepo: dependencies.preferencesRepo,
    dataContext: dependencies.dataContext,
    logger: dependencies.logger,
    fetchFn: dependencies.fetchFn
  });

  const forecastReader = new WeatherForecastReader(
    dependencies.preferencesRepo,
    dependencies.fetchFn
  );
  configureWeatherForecastRead(forecastReader);
  server.get<{ Querystring: WeatherForecastQuery }>(
    "/api/weather/forecast",
    { schema: getWeatherForecastRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const read = await dependencies.dataContext.withDataContext(access, (db) =>
          forecastReader.read(db, access.actorUserId, request.query, request.ip)
        );
        return read;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/weather/today",
    { schema: getWeatherTodayRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const timeZone = await savedTimeZone(dependencies, accessContext);
        const data = await service.getWeatherForUser(accessContext, request.ip, timeZone);
        return { data };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
