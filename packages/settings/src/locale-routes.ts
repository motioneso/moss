import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  DEFAULT_LOCALE_SETTINGS,
  getLocaleSettingsRouteSchema,
  putLocaleSettingsRouteSchema,
  type LocaleDateFormat,
  type LocaleSettingsDto,
  type PutLocaleSettingsRequest
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import type { ProfilePreferencesPort } from "./preferences-port.js";
import { handleSettingsRouteError } from "./route-error.js";

const LOCALE_PREFERENCE_KEY = "locale";

interface LocaleRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: ProfilePreferencesPort;
}

export function registerLocaleRoutes(
  server: FastifyInstance,
  dependencies: LocaleRoutesDependencies
): void {
  server.get("/api/me/locale", { schema: getLocaleSettingsRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const locale = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        dependencies.preferencesRepository.get(scopedDb, LOCALE_PREFERENCE_KEY)
      );
      return { locale: normalizeLocale(locale) };
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });

  server.put("/api/me/locale", { schema: putLocaleSettingsRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const body = request.body as PutLocaleSettingsRequest;
      const locale = sanitizeLocale(body.locale);
      await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        dependencies.preferencesRepository.upsert(scopedDb, LOCALE_PREFERENCE_KEY, locale)
      );
      return { locale };
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });
}

function normalizeLocale(value: unknown): LocaleSettingsDto {
  if (!value || typeof value !== "object") return DEFAULT_LOCALE_SETTINGS;
  const record = value as Record<string, unknown>;
  const timezone =
    typeof record.timezone === "string" && record.timezone.length <= 100 && record.timezone.trim()
      ? record.timezone
      : DEFAULT_LOCALE_SETTINGS.timezone;
  const region =
    typeof record.region === "string" && record.region.length <= 35 && record.region.trim()
      ? record.region
      : DEFAULT_LOCALE_SETTINGS.region;
  const dateFormat = isLocaleDateFormat(record.dateFormat)
    ? record.dateFormat
    : DEFAULT_LOCALE_SETTINGS.dateFormat;
  return { timezone, region, dateFormat };
}

function sanitizeLocale(locale: LocaleSettingsDto): LocaleSettingsDto {
  const timezone = locale.timezone.trim();
  const region = locale.region.trim();
  if (timezone.length === 0) throw new HttpError(400, "Time zone is required");
  if (region.length === 0) throw new HttpError(400, "Language and region is required");
  return { timezone, region, dateFormat: locale.dateFormat };
}

function isLocaleDateFormat(value: unknown): value is LocaleDateFormat {
  return value === "24" || value === "12";
}
