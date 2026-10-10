import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  resolveMossEnv,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
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

import {
  applyLegacyQuietHoursPatch,
  assertNewQuietTimesValid
} from "./legacy-quiet-hours-patch.js";
import { readQuietHoursAuthority, type QuietHoursAuthorityRead } from "./quiet-hours-authority.js";
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
  readonly quietHours?: LegacyQuietHoursPort;
}

/** The quiet-hours authority this route reads and writes through; tests inject a fake. */
export interface LegacyQuietHoursPort {
  read(scopedDb: DataContextDb): Promise<Pick<QuietHoursAuthorityRead, "authority">>;
  applyLegacyPatch: typeof applyLegacyQuietHoursPatch;
}

const defaultQuietHoursPort: LegacyQuietHoursPort = {
  read: readQuietHoursAuthority,
  applyLegacyPatch: applyLegacyQuietHoursPatch
};

export function registerProactiveMonitoringSettingsRoutes(
  server: FastifyInstance,
  dependencies: ProactiveMonitoringSettingsRoutesDependencies
): void {
  const repository = dependencies.repository ?? new ProactiveMonitoringPreferencesRepository();
  const quietHours = dependencies.quietHours ?? defaultQuietHoursPort;

  server.get("/api/me/proactive-monitoring-settings", async (request, reply) => {
    try {
      const ctx = await dependencies.resolveAccessContext(request);
      const { saved, quiet } = await dependencies.dataContext.withDataContext(
        ctx,
        async (scopedDb) => {
          const saved = await repository.initializeAutomaticEmailAlerts(scopedDb);
          if (saved === null) throw new HttpError(409, "Saved alert preference needs recovery");
          if (!saved) throw new HttpError(409, "Saved alert preference needs recovery");
          return { saved, quiet: await quietHours.read(scopedDb) };
        }
      );
      await reconcileScheduleSafe(
        dependencies.reconcileProactiveSchedule,
        ctx.actorUserId,
        saved.preference,
        saved
      );
      return reply.send({ settings: settingsResponse(saved, quiet) });
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

        // Quiet hours go first, under the shared quiet-hours lock, so this route takes its locks in
        // the same order as every other quiet-hours writer. An unambiguous owner's quiet hours
        // land on the one Profile record and leave the alert record untouched.
        const { updated, quiet } = await dependencies.dataContext.withDataContext(
          ctx,
          async (scopedDb) => {
            let nestedPatch = patch;
            if (patch.quietHours !== undefined) {
              const routed = await quietHours.applyLegacyPatch(scopedDb, patch.quietHours);
              if (routed.target === "profile") {
                const { quietHours: _routed, ...rest } = patch;
                nestedPatch = rest;
              }
            }
            const updated =
              Object.keys(nestedPatch).length === 0
                ? await readSavedPreference(repository, scopedDb)
                : await patchAlertRecord(repository, scopedDb, nestedPatch);
            return { updated, quiet: await quietHours.read(scopedDb) };
          }
        );

        if (updated) {
          await reconcileScheduleSafe(
            dependencies.reconcileProactiveSchedule,
            ctx.actorUserId,
            updated.preference,
            updated
          );
        }

        return reply.send({ settings: settingsResponse(updated, quiet) });
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

// The row lock serialises concurrent PATCHes; the retry only covers a concurrent first insert of
// an absent row. Callers send partial patches, so the merge always applies to the latest record.
async function patchAlertRecord(
  repository: ProactiveMonitoringPreferencesRepository,
  scopedDb: DataContextDb,
  patch: Partial<ProactiveMonitoringPreferenceV1>
): Promise<SavedProactiveMonitoringPreference> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const current = await repository.getSavedWithRevision(scopedDb, { forUpdate: true });
    if (current?.saved === null) {
      throw new HttpError(409, "Saved alert preference needs recovery");
    }
    if (patch.quietHours !== undefined) {
      const submitted = objectValue(patch.quietHours);
      const effective =
        current?.saved.preference.quietHours ?? defaultProactiveMonitoringPreference().quietHours;
      assertNewQuietTimesValid(
        effective,
        "startLocalTime" in submitted ? submitted.startLocalTime : effective.startLocalTime,
        "endLocalTime" in submitted ? submitted.endLocalTime : effective.endLocalTime
      );
    }
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
}

async function readSavedPreference(
  repository: ProactiveMonitoringPreferencesRepository,
  scopedDb: DataContextDb
): Promise<SavedProactiveMonitoringPreference | undefined> {
  const saved = await repository.getSaved(scopedDb);
  if (saved === null) throw new HttpError(409, "Saved alert preference needs recovery");
  return saved;
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

/**
 * An unambiguous owner sees the one quiet-hours schedule. A conflict or a malformed record keeps
 * showing the alert record's own schedule, which is what alert workers still use.
 */
function settingsResponse(
  saved: SavedProactiveMonitoringPreference | undefined,
  quiet: Pick<QuietHoursAuthorityRead, "authority">
): ProactiveMonitoringPreferenceV1 {
  const preference = saved?.preference ?? defaultProactiveMonitoringPreference();
  const effective = quiet.authority.effective;
  return {
    ...preference,
    automaticEmailAlerts: resolveAutomaticEmailAlertsEnabled(saved),
    ...(effective
      ? {
          quietHours: {
            enabled: effective.enabled,
            startLocalTime: effective.start,
            endLocalTime: effective.end
          }
        }
      : {})
  };
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
