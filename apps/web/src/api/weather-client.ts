import type {
  GetWeatherLocationResponse,
  GetWeatherTodayResponse,
  GetWeatherUnitResponse,
  PutWeatherLocationRequest,
  PutWeatherLocationResponse,
  PutWeatherUnitRequest,
  PutWeatherUnitResponse,
  ReverseWeatherLocationResponse,
  SearchWeatherLocationsResponse
} from "@moss/shared";

import { requestJson } from "./client.js";

export async function getWeatherToday(): Promise<GetWeatherTodayResponse> {
  return requestJson<GetWeatherTodayResponse>("/api/weather/today");
}

export async function getWeatherLocationSettings(): Promise<GetWeatherLocationResponse> {
  return requestJson<GetWeatherLocationResponse>("/api/me/weather-location");
}

export async function putWeatherLocationSettings(
  body: PutWeatherLocationRequest
): Promise<PutWeatherLocationResponse> {
  return requestJson<PutWeatherLocationResponse>("/api/me/weather-location", {
    method: "PUT",
    body
  });
}

export async function searchWeatherLocations(
  query: string
): Promise<SearchWeatherLocationsResponse> {
  return requestJson<SearchWeatherLocationsResponse>(
    `/api/me/weather-location/search?query=${encodeURIComponent(query)}`
  );
}

export async function reverseWeatherLocation(
  lat: number,
  lon: number
): Promise<ReverseWeatherLocationResponse> {
  return requestJson<ReverseWeatherLocationResponse>(
    `/api/me/weather-location/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
  );
}

export async function getWeatherUnitSettings(): Promise<GetWeatherUnitResponse> {
  return requestJson<GetWeatherUnitResponse>("/api/me/weather-unit");
}

export async function putWeatherUnitSettings(
  unit: PutWeatherUnitRequest["unit"]
): Promise<PutWeatherUnitResponse> {
  return requestJson<PutWeatherUnitResponse>("/api/me/weather-unit", {
    method: "PUT",
    body: { unit }
  });
}
