import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  LOCALE_PREFERENCE_KEY,
  getLocaleSettingsRouteSchema,
  putLocaleSettingsRouteSchema,
  resolveEffectiveLocale,
  type LocaleSettingsDto,
  type PutLocaleSettingsRequest
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import type { QuietHoursPreferencesPort } from "./preferences-port.js";
import { freezeQuietHoursBeforeLocaleWrite } from "./quiet-hours-writer.js";
import { handleSettingsRouteError } from "./route-error.js";

interface LocaleRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly preferencesRepository: QuietHoursPreferencesPort;
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
      return { locale: resolveEffectiveLocale(locale) };
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });

  server.put("/api/me/locale", { schema: putLocaleSettingsRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const body = request.body as PutLocaleSettingsRequest;
      const locale = sanitizeLocale(body.locale);
      await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
        await freezeQuietHoursBeforeLocaleWrite(scopedDb, dependencies.preferencesRepository);
        await dependencies.preferencesRepository.upsert(scopedDb, LOCALE_PREFERENCE_KEY, locale);
      });
      return { locale };
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });
}

function sanitizeLocale(locale: LocaleSettingsDto): LocaleSettingsDto {
  const timezone = locale.timezone.trim();
  const region = locale.region.trim();
  if (timezone.length === 0) throw new HttpError(400, "Time zone is required");
  if (region.length === 0) throw new HttpError(400, "Language and region is required");
  return { timezone, region, dateFormat: locale.dateFormat };
}
