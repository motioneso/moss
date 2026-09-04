import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext } from "@moss/db";
import {
  reverseWeatherLocationRouteSchema,
  searchWeatherLocationsRouteSchema,
  type ReverseWeatherLocationResponse,
  type SearchWeatherLocationsResponse
} from "@moss/shared";
import {
  reverseGeocodeLocation,
  searchOpenMeteoLocations,
  WeatherLocationSearchUnavailableError
} from "@moss/weather";

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

  // Browser coordinates from "Use my location" become a named place here; the
  // client then saves the result through PUT /api/me/weather-location.
  server.get(
    "/api/me/weather-location/reverse",
    { schema: reverseWeatherLocationRouteSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        const { lat, lon } = request.query as { lat: number; lon: number };
        try {
          const location = await reverseGeocodeLocation(lat, lon, dependencies.fetchFn);
          return { location } satisfies ReverseWeatherLocationResponse;
        } catch (error) {
          if (error instanceof WeatherLocationSearchUnavailableError) {
            return reply
              .status(502)
              .send({ error: "Looking up your location is temporarily unavailable" });
          }
          throw error;
        }
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
