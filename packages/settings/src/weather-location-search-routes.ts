import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext } from "@moss/db";
import {
  searchWeatherLocationsRouteSchema,
  type SearchWeatherLocationsResponse
} from "@moss/shared";
import { searchOpenMeteoLocations, WeatherLocationSearchUnavailableError } from "@moss/weather";

import { handleSettingsRouteError } from "./route-error.js";

export interface WeatherLocationSearchRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly fetchFn?: typeof fetch;
}

export function registerWeatherLocationSearchRoutes(
  server: FastifyInstance,
  dependencies: WeatherLocationSearchRoutesDependencies
): void {
  server.get(
    "/api/me/weather-location/search",
    { schema: searchWeatherLocationsRouteSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        const { query } = request.query as { query?: string };
        if (!query || !query.trim()) {
          return { candidates: [] } satisfies SearchWeatherLocationsResponse;
        }
        try {
          const candidates = await searchOpenMeteoLocations(query.trim(), dependencies.fetchFn);
          return { candidates } satisfies SearchWeatherLocationsResponse;
        } catch (error) {
          if (error instanceof WeatherLocationSearchUnavailableError) {
            return reply
              .status(502)
              .send({ error: "Weather location search is temporarily unavailable" });
          }
          throw error;
        }
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
