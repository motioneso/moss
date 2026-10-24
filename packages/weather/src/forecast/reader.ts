import { createHostPinnedFetch } from "@moss/host-fetch";
import { fetchOpenMeteoForecast } from "../open-meteo.js";
import type { WeatherUnit } from "@moss/shared";
import type { DataContextDb, PreferencesPort } from "@moss/db";
import type { WeatherForecastQuery, WeatherForecastRead } from "@moss/shared";
import { searchOpenMeteoLocations } from "../open-meteo-geocode.js";
import { WeatherCache } from "../weather-cache.js";
import {
  WeatherLocationResolver,
  readSavedWeatherZone,
  weatherLocation,
  weatherUnit,
  type ResolvedWeatherLocation
} from "../preferences.js";
import { fetchIntervalForecast } from "./provider.js";
import { selectForecastWindow, validForecastQuery, type IntervalForecast } from "./window.js";

export class WeatherForecastReader {
  private readonly cache = new WeatherCache<IntervalForecast>();
  private readonly locations: WeatherLocationResolver;
  constructor(
    private readonly preferences: PreferencesPort,
    private readonly fetchFn: typeof fetch = createHostPinnedFetch([
      "api.open-meteo.com",
      "geocoding-api.open-meteo.com",
      "ipwho.is"
    ]),
    private readonly now: () => Date = () => new Date()
  ) {
    this.locations = new WeatherLocationResolver(fetchFn);
  }
  async read(
    db: DataContextDb,
    actorUserId: string,
    query: WeatherForecastQuery,
    requestIp: string | null = null
  ): Promise<WeatherForecastRead> {
    if (!validForecastQuery(query))
      return {
        status: "unavailable",
        reason: "Choose a local window of 1–12 hours within the next five days."
      };
    let resolved: ResolvedWeatherLocation | null = null;
    let unit: WeatherUnit = "imperial";
    try {
      if (query.place) {
        const [city = "", ...qualifiers] = query.place
          .split(",")
          .map((v) => v.trim().toLocaleLowerCase());
        const candidates = (await searchOpenMeteoLocations(city, this.fetchFn, 10)).filter(
          (candidate) =>
            weatherLocation(candidate) &&
            qualifiers.every((part) =>
              candidate.label
                .toLocaleLowerCase()
                .split(",")
                .map((v) => v.trim())
                .includes(part)
            )
        );
        if (candidates.length > 1) return { status: "ambiguous", candidates };
        if (!candidates[0])
          return {
            status: "unresolved",
            reason:
              "No unique place found. Give the city and region/country, or set a weather location in Profile."
          };
        resolved = { location: candidates[0], source: "conversation" };
      } else {
        const raw = await this.preferences.get(db, "weather-location");
        resolved = await this.locations.resolve(
          raw,
          requestIp,
          await readSavedWeatherZone(db, this.preferences)
        );
      }
      if (!resolved)
        return {
          status: "unresolved",
          reason:
            "No weather location is available. Set a place in Settings → Profile or name a city and region in this conversation."
        };
      unit = weatherUnit(await this.preferences.get(db, "weather-unit"));
      const key = JSON.stringify([actorUserId, resolved.location.lat, resolved.location.lon, unit]);
      let source = query.refresh ? undefined : this.cache.get(key);
      if (!source) {
        source = await fetchIntervalForecast(
          resolved.location.lat,
          resolved.location.lon,
          unit,
          this.fetchFn,
          this.now
        );
        this.cache.set(key, source, 30 * 60_000);
      }
      const forecast = selectForecastWindow(source, resolved, query, this.now());
      if (!forecast)
        return {
          status: "unavailable",
          reason: "The requested local window cannot be resolved from this forecast."
        };
      return {
        status: "forecast",
        forecast,
        ...(forecast.intervals.length === 0 ? { outlook: await this.outlook(resolved, unit) } : {})
      };
    } catch {
      return {
        status: "unavailable",
        ...(resolved ? { outlook: await this.outlook(resolved, unit) } : {}),
        reason:
          "The hourly forecast is unavailable. Current or daily temperatures cannot establish an evening rain window. Ask for the current outlook or explicitly retry the forecast."
      };
    }
  }
  private async outlook(resolved: ResolvedWeatherLocation, unit: WeatherUnit) {
    try {
      const { lat, lon, label } = resolved.location;
      return await fetchOpenMeteoForecast(lat, lon, unit, label, this.fetchFn);
    } catch {
      return null;
    }
  }
}
