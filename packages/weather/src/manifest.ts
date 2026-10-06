import type { MossModuleManifest } from "@moss/module-sdk";
import { getWeatherTodayRouteSchema } from "@moss/shared";

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
  features: [
    {
      id: "weather.chat_app_actions",
      description:
        "Chat reads the current forecast for the saved location or time-zone fallback. Provider retrieval does not change saved preferences; returned weather remains outside content."
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/weather/today",
      chat: { access: "read" },
      responseSchema: getWeatherTodayRouteSchema.response[200],
      permissionId: "weather.view"
    }
  ]
} satisfies MossModuleManifest;
