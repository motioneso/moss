import type { DataContextDb, PreferencesPort } from "@moss/db";
import {
  LOCALE_PREFERENCE_KEY,
  isValidTimeZone,
  type WeatherLocationDto,
  type WeatherUnit
} from "@moss/shared";
import { geocodeIp } from "./ip-geocoder.js";
import { lookupCityForTimeZone } from "./timezone-city.js";
import { WeatherCache } from "./weather-cache.js";

export interface ResolvedWeatherLocation {
  readonly location: WeatherLocationDto;
  readonly source: "stored-preference" | "ip-geo" | "timezone-fallback" | "conversation";
}
export function weatherLocation(value: unknown): WeatherLocationDto | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.lat === "number" &&
    Number.isFinite(v.lat) &&
    Math.abs(v.lat) <= 90 &&
    typeof v.lon === "number" &&
    Number.isFinite(v.lon) &&
    Math.abs(v.lon) <= 180 &&
    typeof v.label === "string" &&
    v.label.length > 0 &&
    v.label.length <= 200
    ? { lat: v.lat, lon: v.lon, label: v.label }
    : null;
}
export function weatherUnit(value: unknown): WeatherUnit {
  return value === "metric" ? "metric" : "imperial";
}
export async function readSavedWeatherZone(
  db: DataContextDb,
  preferences: PreferencesPort
): Promise<string | null> {
  const raw = await preferences.get(db, LOCALE_PREFERENCE_KEY);
  const zone = raw && typeof raw === "object" ? (raw as Record<string, unknown>).timezone : null;
  return typeof zone === "string" && isValidTimeZone(zone) ? zone : null;
}
export class WeatherLocationResolver {
  private readonly geoCache = new WeatherCache<WeatherLocationDto | null>();
  constructor(private readonly fetchFn: typeof fetch) {}
  async resolve(
    raw: unknown,
    requestIp: string | null,
    savedZone: string | null
  ): Promise<ResolvedWeatherLocation | null> {
    const stored = weatherLocation(raw);
    if (stored) return { location: stored, source: "stored-preference" };
    if (requestIp !== null) {
      let geo = this.geoCache.get(requestIp);
      if (geo === undefined) {
        geo = weatherLocation(await geocodeIp(requestIp, this.fetchFn));
        this.geoCache.set(requestIp, geo, 6 * 60 * 60 * 1000);
      }
      if (geo) return { location: geo, source: "ip-geo" };
    }
    const location = savedZone === null ? null : lookupCityForTimeZone(savedZone);
    return location ? { location, source: "timezone-fallback" } : null;
  }
}
