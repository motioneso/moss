import { weatherTodaySchema } from "./weather-api.js";
import { errorResponseSchema } from "./schema-fragments.js";
import type { WeatherLocationDto, WeatherTodayDto, WeatherUnit } from "./weather-api.js";

export interface WeatherForecastQuery {
  readonly place?: string;
  readonly dayOffset?: number;
  readonly startHour?: number;
  readonly endHour?: number;
  readonly refresh?: boolean;
}
export interface WeatherIntervalDto {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly temperature: number;
  readonly condition: string;
  readonly rainProbability: number | null;
  readonly windSpeed: number | null;
}
export interface WeatherWindowDto {
  readonly place: string;
  readonly approximate: boolean;
  readonly locationSource: "stored-preference" | "ip-geo" | "timezone-fallback" | "conversation";
  readonly timeZone: string;
  readonly unit: WeatherUnit;
  readonly windUnit: "mph" | "km/h";
  readonly localDate: string;
  readonly startHour: number;
  readonly endHour: number;
  readonly requestedStart: string;
  readonly requestedEnd: string;
  readonly coveredStart: string | null;
  readonly coveredEnd: string | null;
  readonly coverage: "complete" | "partial" | "missing";
  readonly observedAt: string | null;
  readonly retrievedAt: string;
  readonly stale: boolean;
  readonly intervals: readonly WeatherIntervalDto[];
}
export type WeatherForecastRead =
  | {
      readonly status: "forecast";
      readonly forecast: WeatherWindowDto;
      readonly outlook?: WeatherTodayDto | null;
    }
  | { readonly status: "ambiguous"; readonly candidates: readonly WeatherLocationDto[] }
  | {
      readonly status: "unresolved" | "unavailable";
      readonly reason: string;
      readonly outlook?: WeatherTodayDto | null;
    };

export const weatherForecastQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    place: {
      type: "string",
      minLength: 2,
      maxLength: 200,
      description:
        "Optional city and region/country from the conversation. Omit to use the saved location. Does not save preferences; ambiguous names return candidates for clarification."
    },
    dayOffset: {
      type: "integer",
      minimum: 0,
      maximum: 4,
      description:
        "Calendar days after today in the forecast place's real time zone. Tonight=0, tomorrow=1. Default 0."
    },
    startHour: {
      type: "integer",
      minimum: 0,
      maximum: 23,
      description: "Inclusive local hour, default 18 for evening."
    },
    endHour: {
      type: "integer",
      minimum: 1,
      maximum: 24,
      description:
        "Exclusive local hour, default 22. Must exceed startHour by at most 12. Split overnight requests into separate bounded reads."
    },
    refresh: {
      type: "boolean",
      description:
        "True only for an explicit request to update the forecast; bypasses the bounded cache."
    }
  }
} as const;

const nullableTime = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
export const weatherWindowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "place",
    "approximate",
    "locationSource",
    "timeZone",
    "unit",
    "windUnit",
    "localDate",
    "startHour",
    "endHour",
    "requestedStart",
    "requestedEnd",
    "coveredStart",
    "coveredEnd",
    "coverage",
    "observedAt",
    "retrievedAt",
    "stale",
    "intervals"
  ],
  properties: {
    place: { type: "string" },
    approximate: { type: "boolean" },
    locationSource: {
      type: "string",
      enum: ["stored-preference", "ip-geo", "timezone-fallback", "conversation"]
    },
    timeZone: { type: "string" },
    unit: { type: "string", enum: ["metric", "imperial"] },
    windUnit: { type: "string", enum: ["mph", "km/h"] },
    localDate: { type: "string" },
    startHour: { type: "integer" },
    endHour: { type: "integer" },
    requestedStart: { type: "string" },
    requestedEnd: { type: "string" },
    coveredStart: nullableTime,
    coveredEnd: nullableTime,
    coverage: { type: "string", enum: ["complete", "partial", "missing"] },
    observedAt: nullableTime,
    retrievedAt: { type: "string" },
    stale: { type: "boolean" },
    intervals: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "startsAt",
          "endsAt",
          "temperature",
          "condition",
          "rainProbability",
          "windSpeed"
        ],
        properties: {
          startsAt: { type: "string" },
          endsAt: { type: "string" },
          temperature: { type: "number" },
          condition: { type: "string" },
          rainProbability: {
            anyOf: [{ type: "number", minimum: 0, maximum: 100 }, { type: "null" }]
          },
          windSpeed: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] }
        }
      }
    }
  }
} as const;
export const getWeatherForecastRouteSchema = {
  querystring: weatherForecastQuerySchema,
  response: {
    200: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "forecast"],
          properties: {
            status: { const: "forecast" },
            forecast: weatherWindowSchema,
            outlook: { anyOf: [weatherTodaySchema, { type: "null" }] }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "candidates"],
          properties: {
            status: { const: "ambiguous" },
            candidates: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["lat", "lon", "label"],
                properties: {
                  lat: { type: "number" },
                  lon: { type: "number" },
                  label: { type: "string" }
                }
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "reason"],
          properties: {
            status: { type: "string", enum: ["unavailable", "unresolved"] },
            reason: { type: "string" },
            outlook: { anyOf: [weatherTodaySchema, { type: "null" }] }
          }
        }
      ]
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;
