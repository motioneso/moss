import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import {
  getWeatherTodayRouteSchema,
  LOCALE_PREFERENCE_KEY,
  resolveEffectiveLocale
} from "@moss/shared";
import { WeatherService } from "./weather-service.js";

interface WeatherRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepo: PreferencesPort;
  readonly logger: FastifyBaseLogger;
  readonly fetchFn?: typeof fetch;
}

/** The person's saved locale timezone, or the shared default when nothing is saved (#3395). */
async function resolveRouteTimeZone(
  dependencies: WeatherRoutesDependencies,
  accessContext: AccessContext
): Promise<string> {
  const stored = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
    dependencies.preferencesRepo.get(scopedDb, LOCALE_PREFERENCE_KEY)
  );
  return resolveEffectiveLocale(stored).timezone;
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

  server.get(
    "/api/weather/today",
    { schema: getWeatherTodayRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const timeZone = await resolveRouteTimeZone(dependencies, accessContext);
        const data = await service.getWeatherForUser(accessContext, request.ip, timeZone);
        return { data };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
