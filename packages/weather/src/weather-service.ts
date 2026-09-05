import type { FastifyBaseLogger } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import type { WeatherLocationDto, WeatherTodayDto, WeatherUnit } from "@moss/shared";
import { fetchOpenMeteoForecast, WeatherUnavailableError } from "./open-meteo.js";
import { geocodeIp } from "./ip-geocoder.js";
import { WeatherCache } from "./weather-cache.js";
import { lookupCityForTimeZone } from "./timezone-city.js";

const WEATHER_LOCATION_KEY = "weather-location";
const WEATHER_UNIT_KEY = "weather-unit";
const DEFAULT_WEATHER_UNIT: WeatherUnit = "imperial";
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;
const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface WeatherServiceDependencies {
  readonly preferencesRepo: PreferencesPort;
  readonly dataContext: DataContextRunner;
  readonly logger: FastifyBaseLogger;
  readonly fetchFn?: typeof fetch;
}

interface CachedWeather {
  readonly resolvedLocation: ResolvedLocation;
  readonly unit: WeatherUnit;
  readonly data: WeatherTodayDto;
}

interface ResolvedLocation {
  readonly location: WeatherLocationDto;
  readonly source: "stored-preference" | "ip-geo" | "timezone-fallback";
}

export class WeatherService {
  private readonly weatherCache = new WeatherCache<CachedWeather>();
  private readonly geoCache = new WeatherCache<WeatherLocationDto | null>();
  private readonly preferencesRepo: PreferencesPort;
  private readonly dataContext: DataContextRunner;
  private readonly logger: FastifyBaseLogger;
  private readonly fetchFn: typeof fetch;

  constructor(deps: WeatherServiceDependencies) {
    this.preferencesRepo = deps.preferencesRepo;
    this.dataContext = deps.dataContext;
    this.logger = deps.logger;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async getWeatherForUser(
    accessContext: AccessContext,
    requestIp: string,
    timeZone: string
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
    return raw === "metric" || raw === "imperial" ? raw : DEFAULT_WEATHER_UNIT;
  }

  private async resolveLocation(
    accessContext: AccessContext,
    requestIp: string,
    timeZone: string
  ): Promise<ResolvedLocation | null> {
    const raw = await this.dataContext.withDataContext(accessContext, (scopedDb) =>
      this.preferencesRepo.get(scopedDb, WEATHER_LOCATION_KEY)
    );
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      if (typeof r.lat === "number" && typeof r.lon === "number" && typeof r.label === "string") {
        this.logger.info({ step: "stored-preference" }, "weather location resolved");
        return {
          location: { lat: r.lat, lon: r.lon, label: r.label },
          source: "stored-preference"
        };
      }
    }

    // Fall back to IP geo (cached by IP, not by user)
    let geo = this.geoCache.get(requestIp);
    if (geo === undefined) {
      geo = await geocodeIp(requestIp, this.fetchFn);
      this.geoCache.set(requestIp, geo, GEO_CACHE_TTL_MS);
    }
    if (geo) {
      this.logger.info({ step: "ip-geo" }, "weather location resolved");
      return { location: geo, source: "ip-geo" };
    }

    // Fall back to a static timezone->city table (no new outbound egress)
    const cityFallback = lookupCityForTimeZone(timeZone);
    if (cityFallback) {
      this.logger.info({ step: "timezone-fallback" }, "weather location resolved");
      return { location: cityFallback, source: "timezone-fallback" };
    }

    this.logger.info({ step: "unresolved" }, "weather location unresolved");
    return null;
  }
}

function sameLocation(left: ResolvedLocation, right: ResolvedLocation): boolean {
  return (
    left.source === right.source &&
    left.location.lat === right.location.lat &&
    left.location.lon === right.location.lon &&
    left.location.label === right.location.label
  );
}
