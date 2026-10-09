import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveMossEnv, type AccessContext, type DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";
import {
  ProactiveMonitoringPreferencesRepository,
  resolveAutomaticEmailAlertsEnabled,
  validateProactiveMonitoringPreference
} from "@moss/proactive-monitoring";
import type { ProactiveMonitoringPreferenceV1, ProactiveSource } from "@moss/shared";
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
  pref: ProactiveMonitoringPreferenceV1
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
        return settingsResponse(saved ?? defaultProactiveMonitoringPreference(), saved);
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
          const current = await repository.get(scopedDb);
          const merged = mergePreference(current, patch);
          validateProactiveMonitoringPreference(merged);
          await repository.upsert(scopedDb, merged);
          return merged;
        });

        await reconcileScheduleSafe(
          dependencies.reconcileProactiveSchedule,
          ctx.actorUserId,
          updated
        );

        return reply.send({ settings: settingsResponse(updated, updated) });
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
  current: ProactiveMonitoringPreferenceV1,
  patch: Partial<ProactiveMonitoringPreferenceV1>
): ProactiveMonitoringPreferenceV1 {
  const defaults = defaultProactiveMonitoringPreference();
  const sources = patch.sources
    ? mergeSources(current.sources, patch.sources, defaults)
    : current.sources;
  return {
    version: 1,
    ...(typeof patch.automaticEmailAlerts === "boolean"
      ? { automaticEmailAlerts: patch.automaticEmailAlerts }
      : typeof current.automaticEmailAlerts === "boolean"
        ? { automaticEmailAlerts: current.automaticEmailAlerts }
        : {}),
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    sources,
    dailyCardCap:
      typeof patch.dailyCardCap === "number" ? patch.dailyCardCap : current.dailyCardCap,
    quietHours: patch.quietHours
      ? { ...current.quietHours, ...patch.quietHours }
      : current.quietHours,
    updatedAt: new Date().toISOString()
  };
}

function settingsResponse(
  preference: ProactiveMonitoringPreferenceV1,
  saved: ProactiveMonitoringPreferenceV1 | null | undefined
): ProactiveMonitoringPreferenceV1 {
  return { ...preference, automaticEmailAlerts: resolveAutomaticEmailAlertsEnabled(saved) };
}

function mergeSources(
  current: ProactiveMonitoringPreferenceV1["sources"],
  patch: Partial<ProactiveMonitoringPreferenceV1["sources"]>,
  defaults: ProactiveMonitoringPreferenceV1
): ProactiveMonitoringPreferenceV1["sources"] {
  const sources: ProactiveSource[] = ["tasks", "calendar", "email", "notes"];
  const result = { ...current };
  for (const src of sources) {
    if (src in patch) {
      result[src] = { ...current[src], ...patch[src] } as (typeof current)[typeof src];
    }
  }
  return result;
}

async function reconcileScheduleSafe(
  reconcile: ReconcileProactiveScheduleFn | undefined,
  actorUserId: string,
  pref: ProactiveMonitoringPreferenceV1
): Promise<void> {
  if (!reconcile) return;
  try {
    await reconcile(actorUserId, pref);
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
