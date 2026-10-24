import type { FastifyBaseLogger } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import type { WeatherTodayDto, WeatherUnit } from "@moss/shared";
import { fetchOpenMeteoForecast, WeatherUnavailableError } from "./open-meteo.js";
import {
  WeatherLocationResolver,
  weatherUnit,
  type ResolvedWeatherLocation
} from "./preferences.js";
import { WeatherCache } from "./weather-cache.js";

const WEATHER_LOCATION_KEY = "weather-location";
const WEATHER_UNIT_KEY = "weather-unit";
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;

interface WeatherServiceDependencies {
  readonly preferencesRepo: PreferencesPort;
  readonly dataContext: DataContextRunner;
  readonly logger: FastifyBaseLogger;
  readonly fetchFn?: typeof fetch;
}

interface CachedWeather {
  readonly resolvedLocation: ResolvedWeatherLocation;
  readonly unit: WeatherUnit;
  readonly data: WeatherTodayDto;
}

export class WeatherService {
  private readonly weatherCache = new WeatherCache<CachedWeather>();
  private readonly locationResolver: WeatherLocationResolver;
  private readonly preferencesRepo: PreferencesPort;
  private readonly dataContext: DataContextRunner;
  private readonly logger: FastifyBaseLogger;
  private readonly fetchFn: typeof fetch;

  constructor(deps: WeatherServiceDependencies) {
    this.preferencesRepo = deps.preferencesRepo;
    this.dataContext = deps.dataContext;
    this.logger = deps.logger;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.locationResolver = new WeatherLocationResolver(this.fetchFn);
  }

  /**
   * A null request address skips IP geolocation, so a background caller falls back from the
   * stored location straight to the time-zone city. A null zone skips the city guess.
   */
  async getWeatherForUser(
    accessContext: AccessContext,
    requestIp: string | null,
    timeZone: string | null
  ): Promise<WeatherTodayDto | null> {
    const userId = accessContext.actorUserId;
    const resolvedLocation = await this.resolveLocation(accessContext, requestIp, timeZone);
    if (!resolvedLocation) return null;
    const unit = await this.resolveUnit(accessContext);

    const cached = this.weatherCache.get(userId);
    if (cached && cached.unit === unit && sameLocation(cached.resolvedLocation, resolvedLocation)) {
      return cached.data;
    }
    if (cached) this.weatherCache.delete(userId);

    let data: WeatherTodayDto;
    try {
      data = await fetchOpenMeteoForecast(
        resolvedLocation.location.lat,
        resolvedLocation.location.lon,
        unit,
        resolvedLocation.location.label,
        this.fetchFn
      );
    } catch (error) {
      if (error instanceof WeatherUnavailableError) {
        this.logger.warn({ step: "open-meteo" }, "weather forecast unavailable");
        return null;
      }
      throw error;
    }
    this.weatherCache.set(userId, { resolvedLocation, unit, data }, WEATHER_CACHE_TTL_MS);
    return data;
  }

  private async resolveUnit(accessContext: AccessContext): Promise<WeatherUnit> {
    const raw = await this.dataContext.withDataContext(accessContext, (scopedDb) =>
      this.preferencesRepo.get(scopedDb, WEATHER_UNIT_KEY)
    );
    return weatherUnit(raw);
  }

  private async resolveLocation(
    accessContext: AccessContext,
    requestIp: string | null,
    timeZone: string | null
  ): Promise<ResolvedWeatherLocation | null> {
    const raw = await this.dataContext.withDataContext(accessContext, (scopedDb) =>
      this.preferencesRepo.get(scopedDb, WEATHER_LOCATION_KEY)
    );
    const resolved = await this.locationResolver.resolve(raw, requestIp, timeZone);
    this.logger.info({ step: resolved?.source ?? "unresolved" }, "weather location resolved");
    return resolved;
  }
}

function sameLocation(left: ResolvedWeatherLocation, right: ResolvedWeatherLocation): boolean {
  return (
    left.source === right.source &&
    left.location.lat === right.location.lat &&
    left.location.lon === right.location.lon &&
    left.location.label === right.location.label
  );
}
