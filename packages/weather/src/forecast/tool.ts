import { assertDataContextDb } from "@moss/db";
import {
  weatherForecastQuerySchema,
  type WeatherForecastQuery,
  type WeatherWindowDto
} from "@moss/shared";
import type {
  ModuleAssistantToolManifest,
  ToolExecute,
  VisualSnapshotRegistrationService
} from "@moss/module-sdk";
import { weatherWindowCoverage } from "./contract.js";
import type { WeatherForecastReader } from "./reader.js";

let reader: WeatherForecastReader | undefined;
export function configureWeatherForecastRead(value: WeatherForecastReader): void {
  reader = value;
}
export function weatherForecastSnapshot(forecast: WeatherWindowDto) {
  return {
    kind: "weather.forecast",
    origin: "source" as const,
    source: { id: "open-meteo", label: "Open-Meteo" },
    retrievedAt: forecast.retrievedAt,
    coverage: weatherWindowCoverage(forecast),
    fields: { ...forecast, intervals: forecast.intervals.map((item) => ({ ...item })) }
  };
}
export const weatherForecastExecute: ToolExecute = async (db, input, ctx, services) => {
  assertDataContextDb(db);
  if (!reader) throw new Error("Weather forecast reader is not configured");
  const read = await reader.read(db, ctx.actorUserId, input as WeatherForecastQuery);
  if (read.status !== "forecast") return { data: { ...read } };
  const registrar = services?.visualPresentation as VisualSnapshotRegistrationService | undefined;
  const registered = read.forecast.intervals.length
    ? registrar?.registerSnapshot(ctx, weatherForecastSnapshot(read.forecast))
    : undefined;
  return {
    data: {
      ...read,
      ...(registered?.ok
        ? {
            presentation: {
              proposal: {
                catalogVersion: registered.catalogVersion,
                blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
                interactions: []
              }
            }
          }
        : {})
    }
  };
};
export const weatherForecastTool: ModuleAssistantToolManifest = {
  name: "weather.forecast",
  permissionId: "weather.view",
  risk: "read",
  content: "outside",
  description:
    "Read actual hourly weather for jacket, rain or wind advice in a bounded local window. Uses saved place and units; identifies approximate fallback. Tonight defaults to 18–22 in the forecast place's real time zone. Optional conversational place correction never saves Settings; ambiguous places require clarification. Missing intervals cannot prove rain windows. Read-only; source-bound visual available when useful.",
  inputSchema: weatherForecastQuerySchema,
  execute: weatherForecastExecute
};
