import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import { getWeatherTodayRouteSchema } from "@moss/shared";
import { WeatherService } from "./weather-service.js";

interface WeatherRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepo: PreferencesPort;
  readonly logger: FastifyBaseLogger;
  readonly resolveRequestTimeZone?: (
    request: FastifyRequest,
    accessContext: AccessContext
  ) => Promise<string> | string;
  readonly fetchFn?: typeof fetch;
}

async function resolveRouteTimeZone(
  dependencies: WeatherRoutesDependencies,
  request: FastifyRequest,
  accessContext: AccessContext
): Promise<string> {
  return (await dependencies.resolveRequestTimeZone?.(request, accessContext)) ?? request.timeZone ?? "UTC";
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
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const data = await service.getWeatherForUser(accessContext, request.ip, timeZone);
        return { data };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
