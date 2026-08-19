import type {
  GetWeatherLocationResponse,
  GetWeatherTodayResponse,
  PutWeatherLocationRequest,
  PutWeatherLocationResponse
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
