import type { MossModuleManifest } from "@moss/module-sdk";
import { getWeatherForecastRouteSchema, getWeatherTodayRouteSchema } from "@moss/shared";

import { weatherForecastTemplate } from "./forecast/contract.js";
import { weatherForecastTool } from "./forecast/tool.js";

export const WEATHER_MODULE_ID = "weather";

export const weatherModuleManifest = {
  id: WEATHER_MODULE_ID,
  name: "Weather",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true,
    supportsUserDisable: false
  },
  database: {
    migrations: [],
    migrationDirectories: [],
    ownedTables: []
  },
  permissions: [
    {
      id: "weather.view",
      label: "View weather",
      description: "Read the current weather for the active actor.",
      scope: "user",
      actions: ["view"]
    }
  ],
  assistantTools: [weatherForecastTool],
  visualTemplates: [weatherForecastTemplate],
  features: [
    {
      id: "weather.chat_app_actions",
      description:
        "App actions read the forecast for the saved location or time-zone fallback. Retrieved weather is outside content; this read does not change saved preferences."
    },
    {
      id: "weather.visual_forecast",
      description:
        "Chat shows immutable local hourly forecasts in saved units. Matching city names reuse the saved place. Approximate places, missing hours and unknown rain/wind are labeled. Corrections never save Settings; history never refetches.",
      errors: [
        {
          code: "weather_location_ambiguous",
          class: "validation",
          description:
            "The requested place is ambiguous or no location is available. Name a city and region/country."
        },
        {
          code: "weather_intervals_unavailable",
          class: "transient",
          description:
            "Requested hours, time zone or source are unavailable or incomplete. Current/daily readings cannot establish an evening rain window."
        }
      ],
      remediations: [
        {
          id: "weather_location",
          description:
            "Set Weather location and units in Settings → Profile, or correct the city and region in the conversation without saving Settings.",
          path: "/settings?section=profile"
        },
        {
          id: "weather_retry",
          description:
            "Use the narrower current/daily outlook or explicitly ask Moss to update a bounded local forecast window.",
          path: "/chat/messages"
        }
      ]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/weather/forecast",
      chat: {
        access: "read",
        content: "outside",
        outbound: true
      },
      requestSchema: getWeatherForecastRouteSchema.querystring,
      responseSchema: getWeatherForecastRouteSchema.response[200],
      permissionId: "weather.view"
    },
    {
      method: "GET",
      path: "/api/weather/today",
      chat: { access: "read" },
      responseSchema: getWeatherTodayRouteSchema.response[200],
      permissionId: "weather.view"
    }
  ]
} satisfies MossModuleManifest;
