import type { WeatherIcon, WeatherTodayDto } from "@moss/shared";

export class WeatherUnavailableError extends Error {}

// WMO Weather interpretation codes → condition label + icon
// https://open-meteo.com/en/docs#weathervariables
const WMO_CODE_MAP: Record<number, { condition: string; icon: WeatherIcon }> = {
  0: { condition: "Clear sky", icon: "sun" },
  1: { condition: "Mainly clear", icon: "sun" },
  2: { condition: "Partly cloudy", icon: "cloud-sun" },
  3: { condition: "Overcast", icon: "cloud" },
  45: { condition: "Foggy", icon: "cloud" },
  48: { condition: "Icy fog", icon: "cloud" },
  51: { condition: "Light drizzle", icon: "cloud-rain" },
  53: { condition: "Drizzle", icon: "cloud-rain" },
  55: { condition: "Heavy drizzle", icon: "cloud-rain" },
  56: { condition: "Freezing drizzle", icon: "cloud-rain" },
  57: { condition: "Heavy freezing drizzle", icon: "cloud-rain" },
  61: { condition: "Light rain", icon: "cloud-rain" },
  63: { condition: "Rain", icon: "cloud-rain" },
  65: { condition: "Heavy rain", icon: "cloud-rain" },
  66: { condition: "Freezing rain", icon: "cloud-rain" },
  67: { condition: "Heavy freezing rain", icon: "cloud-rain" },
  71: { condition: "Light snow", icon: "cloud-snow" },
  73: { condition: "Snow", icon: "cloud-snow" },
  75: { condition: "Heavy snow", icon: "cloud-snow" },
  77: { condition: "Snow grains", icon: "cloud-snow" },
  80: { condition: "Light showers", icon: "cloud-rain" },
  81: { condition: "Showers", icon: "cloud-rain" },
  82: { condition: "Heavy showers", icon: "cloud-rain" },
  85: { condition: "Snow showers", icon: "cloud-snow" },
  86: { condition: "Heavy snow showers", icon: "cloud-snow" },
  95: { condition: "Thunderstorm", icon: "cloud-rain" },
  96: { condition: "Thunderstorm with hail", icon: "cloud-rain" },
  99: { condition: "Thunderstorm with heavy hail", icon: "cloud-rain" }
};

function resolveWmoCode(code: number): { condition: string; icon: WeatherIcon } {
  return WMO_CODE_MAP[code] ?? { condition: "Unknown", icon: "cloud" };
}

interface OpenMeteoResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
    relative_humidity_2m: number;
    dew_point_2m: number;
    wind_speed_10m: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

export async function fetchOpenMeteoForecast(
  lat: number,
  lon: number,
  unit: "metric" | "imperial",
  location: string,
  fetchFn: typeof fetch = fetch
): Promise<WeatherTodayDto> {
  const tempUnit = unit === "imperial" ? "fahrenheit" : "celsius";
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,dew_point_2m,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
    `&forecast_days=5&timezone=auto` +
    `&temperature_unit=${tempUnit}`;

  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo returned ${response.status}`);
  }
  let data: OpenMeteoResponse;
  try {
    data = (await response.json()) as OpenMeteoResponse;
  } catch {
    throw new WeatherUnavailableError("Open-Meteo returned a non-JSON body");
  }
  const { condition, icon } = resolveWmoCode(data.current.weather_code);
  const forecast = data.daily.time.slice(1).map((date, index) => {
    const dayIndex = index + 1;
    const { icon: dayIcon } = resolveWmoCode(data.daily.weather_code[dayIndex]!);
    return {
      date,
      icon: dayIcon,
      high: Math.round(data.daily.temperature_2m_max[dayIndex]!),
      low: Math.round(data.daily.temperature_2m_min[dayIndex]!)
    };
  });
  return {
    temp: Math.round(data.current.temperature_2m),
    feelsLike: Math.round(data.current.apparent_temperature),
    condition,
    icon,
    location,
    unit,
    humidity: Math.round(data.current.relative_humidity_2m),
    dewPoint: Math.round(data.current.dew_point_2m),
    windSpeed: Math.round(data.current.wind_speed_10m),
    lat,
    lon,
    forecast
  };
}
