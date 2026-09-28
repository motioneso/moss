import type { FastifyBaseLogger } from "fastify";
import type { DataContextRunner } from "@moss/db";
import type { ComposeDeps } from "@moss/briefings";
import { PreferencesRepository } from "@moss/structured-state";
import { WeatherService } from "@moss/weather";

/**
 * Today's forecast for the morning briefing, read through the weather module's public service.
 * The null request address skips IP geolocation: a worker run has no caller address.
 */
export function buildBriefingWeatherPort(
  dataContext: DataContextRunner,
  logger: FastifyBaseLogger,
  fetchFn?: typeof fetch
): NonNullable<ComposeDeps["weatherToday"]> {
  const service = new WeatherService({
    preferencesRepo: new PreferencesRepository(),
    dataContext,
    logger,
    fetchFn
  });
  return (ctx, timeZone) => service.getWeatherForUser(ctx, null, timeZone);
}
