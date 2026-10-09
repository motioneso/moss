import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveMossEnv, type AccessContext, type DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";
import {
  ProactiveMonitoringPreferencesRepository,
  resolveAutomaticEmailAlertsEnabled,
  type SavedProactiveMonitoringPreference
} from "@moss/proactive-monitoring";
import type { ProactiveMonitoringPreferenceV1 } from "@moss/shared";
import { defaultProactiveMonitoringPreference, parsePositiveIntEnv } from "@moss/shared";

const PROACTIVE_SETTINGS_MAX = parsePositiveIntEnv(
  resolveMossEnv(process.env, "JARVIS_RL_PROACTIVE_SETTINGS_MAX"),
  20
);

import { handleSettingsRouteError } from "./route-error.js";

/**
 * Injected by the composition root. Best-effort: implementations swallow errors.
 * Called after a successful PATCH to start/stop per-source recurring jobs.
 */
export type ReconcileProactiveScheduleFn = (
  actorUserId: string,
  pref: ProactiveMonitoringPreferenceV1,
  saved: SavedProactiveMonitoringPreference | null | undefined
) => Promise<void>;

interface ProactiveMonitoringSettingsRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly reconcileProactiveSchedule?: ReconcileProactiveScheduleFn;
  readonly repository?: ProactiveMonitoringPreferencesRepository;
}

export function registerProactiveMonitoringSettingsRoutes(
  server: FastifyInstance,
  dependencies: ProactiveMonitoringSettingsRoutesDependencies
): void {
  const repository = dependencies.repository ?? new ProactiveMonitoringPreferencesRepository();

  server.get("/api/me/proactive-monitoring-settings", async (request, reply) => {
    try {
      const ctx = await dependencies.resolveAccessContext(request);
      const settings = await dependencies.dataContext.withDataContext(ctx, async (scopedDb) => {
        const saved = await repository.getSaved(scopedDb);
        if (saved === null) throw new HttpError(409, "Saved alert preference needs recovery");
        return settingsResponse(saved);
      });
      return reply.send({ settings });
    } catch (error) {
      return handleSettingsRouteError(error, reply);
    }
  });

  server.patch(
    "/api/me/proactive-monitoring-settings",
    {
      config: {
        rateLimit: {
          max: PROACTIVE_SETTINGS_MAX,
          timeWindow: "1 minute",
          keyGenerator: sessionRateLimitKey
        }
      }
    },
    async (request, reply) => {
      try {
        const ctx = await dependencies.resolveAccessContext(request);
        const patch = parseSettingsPatch(request.body);

        const updated = await dependencies.dataContext.withDataContext(ctx, async (scopedDb) => {
          const saved = await repository.getSaved(scopedDb);
          if (saved === null) throw new HttpError(409, "Saved alert preference needs recovery");
          return repository.upsert(scopedDb, mergePreference(saved?.raw, patch));
        });

        await reconcileScheduleSafe(
          dependencies.reconcileProactiveSchedule,
          ctx.actorUserId,
          updated.preference,
          updated
        );

        return reply.send({ settings: settingsResponse(updated) });
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}

function parseSettingsPatch(body: unknown): Partial<ProactiveMonitoringPreferenceV1> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Proactive monitoring settings request is invalid");
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set([
    "automaticEmailAlerts",
    "enabled",
    "sources",
    "dailyCardCap",
    "quietHours"
  ]);
  const unknown = Object.keys(value).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new HttpError(400, `Unknown fields: ${unknown.join(", ")}`);
  }
  return value as Partial<ProactiveMonitoringPreferenceV1>;
}

function mergePreference(
  current: Readonly<Record<string, unknown>> | undefined,
  patch: Partial<ProactiveMonitoringPreferenceV1>
): Record<string, unknown> {
  const currentSources = objectValue(current?.sources);
  const currentQuietHours = objectValue(current?.quietHours);
  return {
    ...(current ?? { version: 1 }),
    ...patch,
    ...(patch.sources ? { sources: { ...currentSources, ...patch.sources } } : {}),
    ...(patch.quietHours ? { quietHours: { ...currentQuietHours, ...patch.quietHours } } : {}),
    updatedAt: new Date().toISOString()
  };
}

function settingsResponse(
  saved: SavedProactiveMonitoringPreference | undefined
): ProactiveMonitoringPreferenceV1 {
  const preference = saved?.preference ?? defaultProactiveMonitoringPreference();
  return { ...preference, automaticEmailAlerts: resolveAutomaticEmailAlertsEnabled(saved) };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function reconcileScheduleSafe(
  reconcile: ReconcileProactiveScheduleFn | undefined,
  actorUserId: string,
  pref: ProactiveMonitoringPreferenceV1,
  saved: SavedProactiveMonitoringPreference
): Promise<void> {
  if (!reconcile) return;
  try {
    await reconcile(actorUserId, pref, saved);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        event: "proactive_schedule_reconcile_failed",
        actorUserId,
        error: err instanceof Error ? err.message : String(err)
      })}\n`
    );
  }
}
