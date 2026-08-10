import type { FastifyBaseLogger } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import type { WeatherLocationDto, WeatherTodayDto } from "@moss/shared";
import { fetchOpenMeteoForecast } from "./open-meteo.js";
import { geocodeIp } from "./ip-geocoder.js";
import { WeatherCache } from "./weather-cache.js";
import { lookupCityForTimeZone } from "./timezone-city.js";

const WEATHER_LOCATION_KEY = "weather-location";
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;
const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface WeatherServiceDependencies {
  readonly preferencesRepo: PreferencesPort;
  readonly dataContext: DataContextRunner;
  readonly logger: FastifyBaseLogger;
  readonly fetchFn?: typeof fetch;
}

export class WeatherService {
  private readonly weatherCache = new WeatherCache<WeatherTodayDto>();
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
    const cached = this.weatherCache.get(userId);
    if (cached) return cached;

    const location = await this.resolveLocation(accessContext, requestIp, timeZone);
    if (!location) return null;

    const data = await fetchOpenMeteoForecast(
      location.lat,
      location.lon,
      "metric",
      location.label,
      this.fetchFn
    );
    this.weatherCache.set(userId, data, WEATHER_CACHE_TTL_MS);
    return data;
  }

  private async resolveLocation(
    accessContext: AccessContext,
    requestIp: string,
    timeZone: string
  ): Promise<WeatherLocationDto | null> {
    const raw = await this.dataContext.withDataContext(accessContext, (scopedDb) =>
      this.preferencesRepo.get(scopedDb, WEATHER_LOCATION_KEY)
    );
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      if (typeof r.lat === "number" && typeof r.lon === "number" && typeof r.label === "string") {
        this.logger.info({ step: "stored-preference" }, "weather location resolved");
        return { lat: r.lat, lon: r.lon, label: r.label };
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
      return geo;
    }

    // Fall back to a static timezone->city table (no new outbound egress)
    const cityFallback = lookupCityForTimeZone(timeZone);
    if (cityFallback) {
      this.logger.info({ step: "timezone-fallback" }, "weather location resolved");
      return cityFallback;
    }

    this.logger.info({ step: "unresolved" }, "weather location resolved");
    return null;
  }
}
