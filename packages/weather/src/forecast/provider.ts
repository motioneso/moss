import { isValidTimeZone, type WeatherUnit } from "@moss/shared";
import { resolveWmoCode, WeatherUnavailableError } from "../open-meteo.js";
import { HOUR_MS, type IntervalForecast } from "./window.js";

interface HourlyPayload {
  readonly timezone?: string;
  readonly hourly_units?: Record<string, unknown>;
  readonly current?: { readonly time?: unknown };
  readonly hourly?: Record<string, unknown>;
}
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const unix = (v: unknown): v is number => finite(v, 0, 4_102_444_800);

export async function fetchIntervalForecast(
  lat: number,
  lon: number,
  unit: WeatherUnit,
  fetchFn: typeof fetch,
  now: () => Date
): Promise<IntervalForecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,weather_code,precipitation_probability,wind_speed_10m",
    current: "temperature_2m",
    forecast_days: "5",
    timezone: "auto",
    timeformat: "unixtime",
    temperature_unit: unit === "imperial" ? "fahrenheit" : "celsius",
    wind_speed_unit: unit === "imperial" ? "mph" : "kmh"
  }).toString();
  const response = await fetchFn(url.toString(), {
    signal: AbortSignal.timeout(15_000),
    redirect: "error"
  });
  if (!response.ok)
    throw new WeatherUnavailableError(`Interval forecast returned ${response.status}`);
  const data: HourlyPayload | null = await response.json();
  if (!data || typeof data.timezone !== "string" || !isValidTimeZone(data.timezone))
    throw new WeatherUnavailableError("Forecast place time zone unavailable");
  const temperatureUnit = unit === "imperial" ? "°F" : "°C";
  if (
    data.hourly_units?.temperature_2m !== temperatureUnit ||
    data.hourly_units?.time !== "unixtime"
  )
    throw new WeatherUnavailableError("Forecast units unavailable");
  const windUnit = unit === "imperial" ? "mph" : "km/h";
  const providerWindUnit = unit === "imperial" ? "mp/h" : "km/h";
  const hourly = data.hourly ?? {};
  const values = (key: string): unknown[] => (Array.isArray(hourly[key]) ? hourly[key] : []);
  const times = values("time");
  if (times.length > 128) throw new WeatherUnavailableError("Forecast interval limit exceeded");
  const temperatures = values("temperature_2m");
  const codes = values("weather_code");
  const rains =
    data.hourly_units?.precipitation_probability === "%" ? values("precipitation_probability") : [];
  const winds =
    data.hourly_units?.wind_speed_10m === providerWindUnit ? values("wind_speed_10m") : [];
  const duplicates = new Set(times.filter((v, index) => times.indexOf(v) !== index));
  const intervals = times.flatMap((time, index) => {
    const temperature = temperatures[index];
    if (!unix(time) || duplicates.has(time) || !finite(temperature, -150, 200)) return [];
    const code = codes[index];
    const rain = rains[index];
    const wind = winds[index];
    return [
      {
        startsAt: new Date(time * 1000).toISOString(),
        endsAt: new Date(time * 1000 + HOUR_MS).toISOString(),
        temperature,
        condition: finite(code, 0, 99) ? resolveWmoCode(code).condition : "Unknown",
        rainProbability: finite(rain, 0, 100) ? rain : null,
        windSpeed: finite(wind, 0, 500) ? wind : null
      }
    ];
  });
  return {
    timeZone: data.timezone,
    unit,
    windUnit,
    retrievedAt: now().toISOString(),
    observedAt: unix(data.current?.time) ? new Date(data.current.time * 1000).toISOString() : null,
    intervals
  };
}
