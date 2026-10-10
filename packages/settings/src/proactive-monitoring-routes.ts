import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveMossEnv, type AccessContext, type DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { sessionRateLimitKey } from "@moss/module-sdk/server";
import {
  ProactiveMonitoringPreferencesRepository,
  ProactivePreferenceRevisionConflictError,
  resolveAutomaticEmailAlertsEnabled,
  type SavedProactiveMonitoringPreference
} from "@moss/proactive-monitoring";
import type { ProactiveMonitoringPreferenceV1 } from "@moss/shared";
import { defaultProactiveMonitoringPreference, parsePositiveIntEnv } from "@moss/shared";

import { isStrictLocalTime } from "./quiet-hours-application.js";
import { handleSettingsRouteError } from "./route-error.js";

const PROACTIVE_SETTINGS_MAX = parsePositiveIntEnv(
  resolveMossEnv(process.env, "JARVIS_RL_PROACTIVE_SETTINGS_MAX"),
  20
);

const MAX_WRITE_ATTEMPTS = 3;

export const PROACTIVE_SETTINGS_CONFLICT_MESSAGE =
  "Alert settings changed while saving. Reload and try again.";

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
      const saved = await dependencies.dataContext.withDataContext(ctx, async (scopedDb) => {
        const saved = await repository.initializeAutomaticEmailAlerts(scopedDb);
        if (saved === null) throw new HttpError(409, "Saved alert preference needs recovery");
        if (!saved) throw new HttpError(409, "Saved alert preference needs recovery");
        return saved;
      });
      await reconcileScheduleSafe(
        dependencies.reconcileProactiveSchedule,
        ctx.actorUserId,
        saved.preference,
        saved
      );
      return reply.send({ settings: settingsResponse(saved) });
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

        // The row lock serialises concurrent PATCHes; the retry only covers a concurrent first
        // insert of an absent row. Callers send partial patches, so the merge always applies to
        // the latest committed record.
        const updated = await dependencies.dataContext.withDataContext(ctx, async (scopedDb) => {
          for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
            const current = await repository.getSavedWithRevision(scopedDb, { forUpdate: true });
            if (current?.saved === null) {
              throw new HttpError(409, "Saved alert preference needs recovery");
            }
            assertNewQuietTimesValid(current?.saved.preference, patch);
            try {
              return await repository.upsertWithRevision(
                scopedDb,
                mergePreference(current?.saved.raw, patch),
                current?.revision ?? null
              );
            } catch (error) {
              if (!(error instanceof ProactivePreferenceRevisionConflictError)) throw error;
            }
          }
          throw new HttpError(409, PROACTIVE_SETTINGS_CONFLICT_MESSAGE);
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

/**
 * Validates only quiet times the patch changes. Saved legacy values (loose HH:MM, equal times)
 * stay effective until the user edits them.
 */
function assertNewQuietTimesValid(
  current: ProactiveMonitoringPreferenceV1 | undefined,
  patch: Partial<ProactiveMonitoringPreferenceV1>
): void {
  if (patch.quietHours === undefined) return;
  const submitted = objectValue(patch.quietHours);
  const effective = current?.quietHours ?? defaultProactiveMonitoringPreference().quietHours;
  const start = "startLocalTime" in submitted ? submitted.startLocalTime : effective.startLocalTime;
  const end = "endLocalTime" in submitted ? submitted.endLocalTime : effective.endLocalTime;
  const startChanged = start !== effective.startLocalTime;
  const endChanged = end !== effective.endLocalTime;
  if (startChanged && !isStrictLocalTime(start)) {
    throw new HttpError(400, "quietHours.startLocalTime must be HH:MM (00:00-23:59)");
  }
  if (endChanged && !isStrictLocalTime(end)) {
    throw new HttpError(400, "quietHours.endLocalTime must be HH:MM (00:00-23:59)");
  }
  if ((startChanged || endChanged) && start === end) {
    throw new HttpError(400, "Quiet hours must start and end at different times");
  }
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
    ...(patch.sources ? { sources: mergeSources(currentSources, patch.sources) } : {}),
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

function mergeSources(
  current: Record<string, unknown>,
  patch: Partial<ProactiveMonitoringPreferenceV1["sources"]>
): Record<string, unknown> {
  const merged = { ...current };
  for (const [source, value] of Object.entries(patch)) {
    merged[source] = { ...objectValue(current[source]), ...objectValue(value) };
  }
  return merged;
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
