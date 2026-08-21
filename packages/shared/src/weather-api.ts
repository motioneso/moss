import { errorResponseSchema } from "./schema-fragments.js";

export type WeatherIcon = "sun" | "cloud" | "cloud-sun" | "cloud-rain" | "cloud-snow" | "wind";

export type WeatherUnit = "metric" | "imperial";

export interface WeatherTodayDto {
  readonly temp: number;
  readonly feelsLike: number;
  readonly condition: string;
  readonly icon: WeatherIcon;
  readonly location: string;
  readonly unit: WeatherUnit;
}

export interface GetWeatherTodayResponse {
  readonly data: WeatherTodayDto | null;
}

export interface WeatherLocationDto {
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
}

export interface GetWeatherLocationResponse {
  readonly location: WeatherLocationDto | null;
}

export type PutWeatherLocationRequest = WeatherLocationDto | null;
export type PutWeatherLocationResponse = GetWeatherLocationResponse;

const weatherIconValues = [
  "sun",
  "cloud",
  "cloud-sun",
  "cloud-rain",
  "cloud-snow",
  "wind"
] as const;

const weatherTodaySchema = {
  type: "object",
  additionalProperties: false,
  required: ["temp", "feelsLike", "condition", "icon", "location", "unit"],
  properties: {
    temp: { type: "number" },
    feelsLike: { type: "number" },
    condition: { type: "string" },
    icon: { type: "string", enum: weatherIconValues },
    location: { type: "string" },
    unit: { type: "string", enum: ["metric", "imperial"] }
  }
} as const;

export const getWeatherTodayRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["data"],
      properties: {
        data: {
          oneOf: [weatherTodaySchema, { type: "null" }]
        }
      }
    },
    401: errorResponseSchema
  }
} as const;

const weatherLocationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lat", "lon", "label"],
  properties: {
    lat: { type: "number", minimum: -90, maximum: 90 },
    lon: { type: "number", minimum: -180, maximum: 180 },
    label: { type: "string", maxLength: 200 }
  }
} as const;

export const getWeatherLocationRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["location"],
      properties: {
        location: {
          oneOf: [weatherLocationSchema, { type: "null" }]
        }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const putWeatherLocationRouteSchema = {
  body: {
    oneOf: [weatherLocationSchema, { type: "null" }]
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["location"],
      properties: {
        location: {
          oneOf: [weatherLocationSchema, { type: "null" }]
        }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export type WeatherLocationCandidateDto = WeatherLocationDto;

export interface SearchWeatherLocationsResponse {
  readonly candidates: readonly WeatherLocationCandidateDto[];
}

export const searchWeatherLocationsRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string" }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["candidates"],
      properties: {
        candidates: { type: "array", items: weatherLocationSchema }
      }
    },
    401: errorResponseSchema,
    502: errorResponseSchema
  }
} as const;

export interface WeatherUnitDto {
  readonly unit: WeatherUnit;
}

export type GetWeatherUnitResponse = WeatherUnitDto;
export type PutWeatherUnitRequest = WeatherUnitDto;
export type PutWeatherUnitResponse = WeatherUnitDto;

const weatherUnitSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unit"],
  properties: {
    unit: { type: "string", enum: ["metric", "imperial"] }
  }
} as const;

export const getWeatherUnitRouteSchema = {
  response: {
    200: weatherUnitSchema,
    401: errorResponseSchema
  }
} as const;

export const putWeatherUnitRouteSchema = {
  body: weatherUnitSchema,
  response: {
    200: weatherUnitSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
