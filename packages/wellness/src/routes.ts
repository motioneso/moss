import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import {
  createCheckinRouteSchema,
  createMedicationLogRouteSchema,
  createMedicationRouteSchema,
  listCheckinsRouteSchema,
  listMedicationsRouteSchema,
  medicationScheduleRouteSchema,
  updateMedicationRouteSchema,
  wellnessInsightsRouteSchema,
  listTherapyNotesRouteSchema,
  createTherapyNoteRouteSchema,
  deleteTherapyNoteRouteSchema,
  medicationAdherenceSummaryRouteSchema,
  putWellnessAiConsentRequestSchema,
  updateCheckinRouteSchema,
  wellnessAiConsentResponseSchema,
  WELLNESS_EMOTION_CORES,
  MEDICATION_LOG_STATUSES,
  isValidFeelingPath,
  localDay,
  type MedicationLogStatusApi,
  type WellnessEmotionCore as WellnessFeelingCore
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import {
  readWellnessAiConsentState,
  resolveEffectiveWellnessConsent,
  WELLNESS_AI_CONSENT_PREFERENCE_KEY
} from "./ai-consent.js";
import type {
  CreateCheckinInput,
  UpdateCheckinInput,
  CreateTherapyNoteInput,
  LogDoseInput
} from "./repository.js";
import { medicationLogBelongsToDate, WellnessRepository } from "./repository.js";
import { WellnessRecallContributor } from "./recall-context.js";
import { computeSchedule } from "./schedule.js";
import {
  serializeCheckin,
  serializeMedication,
  serializeMedicationLog,
  serializeTherapyNote
} from "./serialize.js";
import { computeInsights } from "./insights.js";
import {
  parseCreateMedicationBody,
  parseUpdateMedicationBody
} from "./medication-request-parsing.js";
import {
  optionalNullableString,
  parseOptionalStringArray,
  parseStringArray,
  requireObject,
  requiredString
} from "./parse-helpers.js";

export interface WellnessRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly resolveActiveModules?: (
    actorUserId: string
  ) => Promise<readonly { readonly id: string }[]>;
  readonly resolveRequestTimeZone?: (
    request: FastifyRequest,
    accessContext: AccessContext
  ) => Promise<string>;
  readonly repository?: WellnessRepository;
}

interface MedParams {
  readonly id: string;
}

export function registerWellnessRoutes(
  server: FastifyInstance,
  dependencies: WellnessRoutesDependencies
): void {
  const repo = dependencies.repository ?? new WellnessRepository();
  const preferences = new PreferencesRepository();
  const recallContributor = new WellnessRecallContributor();

  // ── AI consent ───────────────────────────────────────────────────────────
  server.get(
    "/api/wellness/ai-consent",
    {
      schema: {
        response: { 200: wellnessAiConsentResponseSchema }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const wellnessActive = await isWellnessActive(dependencies, accessContext.actorUserId);
        return dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          readWellnessAiConsentState(scopedDb, preferences, wellnessActive)
        );
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/wellness/ai-consent",
    {
      schema: {
        body: putWellnessAiConsentRequestSchema,
        response: { 200: wellnessAiConsentResponseSchema }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const granted = parseAiConsentBody(request.body);
        const wellnessActive = await isWellnessActive(dependencies, accessContext.actorUserId);
        return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await preferences.upsert(scopedDb, WELLNESS_AI_CONSENT_PREFERENCE_KEY, granted);
          if (!granted) {
            // Consent revoked: stop any already-written energy-trend fact from reaching
            // prompts immediately, rather than waiting on the next check-in (#769).
            await recallContributor.invalidateEnergyTrendFact(scopedDb, accessContext.actorUserId);
          }
          return readWellnessAiConsentState(scopedDb, preferences, wellnessActive);
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Check-ins ────────────────────────────────────────────────────────────
  server.post(
    "/api/wellness/checkins",
    { schema: createCheckinRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseCheckinBody(request.body);
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const checkin = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const created = await repo.createCheckin(scopedDb, input, timeZone);
            const consentGranted = await resolveWellnessConsent(
              dependencies,
              preferences,
              scopedDb,
              accessContext.actorUserId
            );
            await recallContributor.refreshEnergyTrendFact(
              scopedDb,
              accessContext.actorUserId,
              consentGranted
            );
            return created;
          }
        );
        return reply.code(201).send({ checkin: serializeCheckin(checkin) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/wellness/checkins",
    { schema: listCheckinsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const query = request.query as Record<string, unknown>;
        const since = parseSince(query["since"]);
        const limit = parseLimit(query["limit"]);
        const checkins = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.listCheckins(scopedDb, { since, limit })
        );
        return { checkins: checkins.map(serializeCheckin) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: { id: string } }>(
    "/api/wellness/checkins/:id",
    { schema: updateCheckinRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseUpdateCheckinBody(request.body);
        const checkin = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const updated = await repo.updateCheckin(scopedDb, request.params.id, input);
            if (updated && input.energy !== undefined) {
              const consentGranted = await resolveWellnessConsent(
                dependencies,
                preferences,
                scopedDb,
                accessContext.actorUserId
              );
              await recallContributor.refreshEnergyTrendFact(
                scopedDb,
                accessContext.actorUserId,
                consentGranted
              );
            }
            return updated;
          }
        );
        if (!checkin) return reply.code(404).send({ error: "Check-in not found" });
        return { checkin: serializeCheckin(checkin) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Medications ──────────────────────────────────────────────────────────
  server.get(
    "/api/wellness/medications",
    { schema: listMedicationsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const meds = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.listMedications(scopedDb)
        );
        return { medications: meds.map(serializeMedication) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/wellness/medications",
    { schema: createMedicationRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseCreateMedicationBody(request.body);
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const med = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.createMedication(scopedDb, input, timeZone)
        );
        return reply.code(201).send({ medication: serializeMedication(med) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: MedParams }>(
    "/api/wellness/medications/:id",
    { schema: updateMedicationRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseUpdateMedicationBody(request.body);
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const med = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            // Turning reminders on without also changing the schedule: the request never named a
            // frequency type, so check the STORED one. A PRN medication has no scheduled time for
            // a reminder to fire on, and the DB CHECK would otherwise surface that as a 500.
            if (input.remindersEnabled === true && !input.schedule) {
              const existing = await repo.getMedication(scopedDb, request.params.id);
              if (existing?.frequency_type === "as_needed") {
                throw new HttpError(400, "remindersEnabled is not allowed for as_needed");
              }
            }
            return repo.updateMedication(scopedDb, request.params.id, input, timeZone);
          }
        );
        if (!med) return reply.code(404).send({ error: "Medication not found" });
        return { medication: serializeMedication(med) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/wellness/medications/schedule",
    { schema: medicationScheduleRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const query = request.query as Record<string, unknown>;
        const dateStr = parseDateParam(query["date"]);
        const date = new Date(`${dateStr}T00:00:00.000Z`);
        const { meds, logs } = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => ({
            meds: await repo.listMedications(scopedDb),
            logs: await repo.listLogsForDate(scopedDb, date, timeZone)
          })
        );
        return { date: dateStr, slots: computeSchedule(meds, logs, date) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: MedParams }>(
    "/api/wellness/medications/:id/logs",
    { schema: createMedicationLogRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseLogDoseBody(request.body);
        const result = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const med = await repo.getMedication(scopedDb, request.params.id);
            if (!med) return null;
            return repo.logDose(scopedDb, request.params.id, input);
          }
        );
        if (!result) return reply.code(404).send({ error: "Medication not found" });
        return reply.code(201).send({ log: serializeMedicationLog(result) });
      } catch (error) {
        // Re-logging the same scheduled slot now UPSERTS (corrects the adherence record) in the
        // repository, so the partial unique index no longer rejects a status correction. This
        // 409 mapping is retained only as a defensive fallback for any unforeseen unique
        // violation — it should not fire on the normal log/correct flow.
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "This scheduled dose is already logged" });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Insights ─────────────────────────────────────────────────────────────
  server.get(
    "/api/wellness/insights",
    { schema: wellnessInsightsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const now = new Date();
        const sinceDays = 30;
        const { checkins, logs, meds } = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => ({
            checkins: await repo.listRecentCheckinsForInsights(scopedDb, sinceDays),
            logs: await repo.listLogsRange(scopedDb, { sinceDays }),
            meds: await repo.listMedications(scopedDb)
          })
        );
        // Count expected scheduled slots across the 30-day window so missed doses
        // are included in the adherence denominator (not just logged rows).
        let totalExpectedSlots = 0;
        for (let i = sinceDays - 1; i >= 0; i--) {
          const day = new Date(`${addDays(localDay(now, timeZone), -i)}T00:00:00.000Z`);
          const dayLogs = logs.filter((log) => medicationLogBelongsToDate(log, day, timeZone));
          const slots = computeSchedule(meds, dayLogs, day);
          totalExpectedSlots += slots.filter((s) => !s.asNeeded).length;
        }
        const insights = computeInsights(checkins, logs, meds, now, totalExpectedSlots);
        return { insights };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Therapy notes ────────────────────────────────────────────────────────
  server.get(
    "/api/wellness/therapy-notes",
    { schema: listTherapyNotesRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const notes = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.listTherapyNotes(scopedDb)
        );
        return { notes: notes.map(serializeTherapyNote) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/wellness/therapy-notes",
    { schema: createTherapyNoteRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseTherapyNoteBody(request.body);
        const note = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.createTherapyNote(scopedDb, input)
        );
        return reply.code(201).send({ note: serializeTherapyNote(note) });
      } catch (error) {
        // P0001: SECURITY INVOKER trigger rejects cross-owner linkedCheckinId (treat as not found).
        // 23503: FK violation — linkedCheckinId doesn't exist at all. Both → 404 (no ownership leak).
        if (isRaisedException(error) || isFkViolation(error)) {
          return reply.code(404).send({ error: "linked check-in not found" });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/api/wellness/therapy-notes/:id",
    { schema: deleteTherapyNoteRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const deleted = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.deleteTherapyNote(scopedDb, request.params.id)
        );
        if (!deleted) return reply.code(404).send({ error: "Therapy note not found" });
        return { deleted: true };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Medication adherence summary ─────────────────────────────────────────
  // Replaces raw-logs endpoint: returns per-day adherence computed server-side via
  // computeSchedule so missed doses count in the denominator and no raw dose/prnReason leak.
  server.get(
    "/api/wellness/medications/logs",
    { schema: medicationAdherenceSummaryRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const timeZone = await resolveRouteTimeZone(dependencies, request, accessContext);
        const query = request.query as Record<string, unknown>;
        const sinceDays = parseSinceDays(query["sinceDays"]);
        const { meds, logs } = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => ({
            meds: await repo.listMedications(scopedDb),
            logs: await repo.listLogsRange(scopedDb, { sinceDays })
          })
        );
        const now = new Date();
        const days = [];
        for (let i = sinceDays - 1; i >= 0; i--) {
          const dateStr = addDays(localDay(now, timeZone), -i);
          const day = new Date(`${dateStr}T00:00:00.000Z`);
          const dayLogs = logs.filter((log) => medicationLogBelongsToDate(log, day, timeZone));
          const slots = computeSchedule(meds, dayLogs, day);
          days.push({
            date: dateStr,
            scheduledCount: slots.filter((s) => !s.asNeeded).length,
            takenCount: slots.filter((s) => !s.asNeeded && s.status === "taken").length,
            doses: slots.map((s) => ({
              medicationId: s.medicationId,
              name: s.name,
              status: s.status,
              prn: s.asNeeded
            }))
          });
        }
        return { days };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function isUniqueViolation(error: unknown): boolean {
  // Postgres unique_violation. The driver surfaces `.code` on the error object.
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

function isFkViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23503"
  );
}

function isRaisedException(error: unknown): boolean {
  // SQLSTATE P0001: RAISE EXCEPTION from a trigger (e.g. cross-owner linkedCheckinId rejection).
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "P0001"
  );
}

async function isWellnessActive(
  dependencies: WellnessRoutesDependencies,
  actorUserId: string
): Promise<boolean> {
  const modules = await dependencies.resolveActiveModules?.(actorUserId);
  return modules?.some((module) => module.id === "wellness") ?? true;
}

/**
 * Resolve effective Wellness AI consent for a recall-contributor write path. Routes don't
 * have a `ToolServices` registry handle (that's only injected on the tool-execution path —
 * see `tools.ts`), so this passes `services: undefined` and supplies the module-active
 * fallback directly via `isWellnessActive`, reusing the exact same
 * `resolveEffectiveWellnessConsent` helper the AI-read tools gate on (#769).
 */
async function resolveWellnessConsent(
  dependencies: WellnessRoutesDependencies,
  preferences: PreferencesRepository,
  scopedDb: DataContextDb,
  actorUserId: string
): Promise<boolean> {
  const wellnessActive = await isWellnessActive(dependencies, actorUserId);
  return resolveEffectiveWellnessConsent(scopedDb, preferences, undefined, wellnessActive);
}

async function resolveRouteTimeZone(
  dependencies: WellnessRoutesDependencies,
  request: FastifyRequest,
  accessContext: AccessContext
): Promise<string> {
  return dependencies.resolveRequestTimeZone?.(request, accessContext) ?? request.timeZone ?? "UTC";
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return localDay(new Date(Date.UTC(year!, month! - 1, day! + days)), "UTC");
}

// ── Body parsers ─────────────────────────────────────────────────────────────

function parseAiConsentBody(body: unknown): boolean {
  const value = requireObject(body);
  if (typeof value["granted"] !== "boolean") {
    throw new HttpError(400, "granted must be a boolean");
  }
  return value["granted"];
}

function parseCheckinBody(body: unknown): CreateCheckinInput {
  const value = requireObject(body);
  const feelingCore = value["feelingCore"];
  if (!isFeelingCore(feelingCore)) {
    throw new HttpError(400, `feelingCore must be one of ${WELLNESS_EMOTION_CORES.join(", ")}`);
  }
  const intensity = value["intensity"];
  if (intensity !== undefined && intensity !== null) {
    if (
      typeof intensity !== "number" ||
      !Number.isInteger(intensity) ||
      intensity < 1 ||
      intensity > 5
    ) {
      throw new HttpError(400, "intensity must be an integer from 1 to 5");
    }
  }
  const energy = value["energy"];
  if (energy !== undefined && energy !== null) {
    if (typeof energy !== "number" || !Number.isInteger(energy) || energy < 1 || energy > 5) {
      throw new HttpError(400, "energy must be an integer from 1 to 5");
    }
  }
  const identifiedVia = value["identifiedVia"];
  if (identifiedVia !== undefined && identifiedVia !== "wheel" && identifiedVia !== "assisted") {
    throw new HttpError(400, "identifiedVia must be wheel or assisted");
  }
  const feelingSecondary = optionalNullableString(value["feelingSecondary"], "feelingSecondary");
  const feelingTertiary = optionalNullableString(value["feelingTertiary"], "feelingTertiary");
  // Validate the (core, secondary?, tertiary?) PATH against the taxonomy — not just each field
  // individually (Codex R2): reject e.g. a tertiary that isn't a leaf of its secondary, or a
  // tertiary supplied without its secondary. `undefined`/`null`/`""` normalize to no selection.
  if (!isValidFeelingPath(feelingCore, feelingSecondary ?? null, feelingTertiary ?? null)) {
    throw new HttpError(
      400,
      "feelingSecondary/feelingTertiary must form a valid path under feelingCore"
    );
  }
  return {
    feelingCore,
    feelingSecondary,
    feelingTertiary,
    sensations: parseStringArray(value["sensations"], "sensations"),
    intensity: intensity === undefined ? undefined : (intensity as number | null),
    energy: energy === undefined ? undefined : (energy as number | null),
    note: optionalNullableString(value["note"], "note"),
    identifiedVia: identifiedVia as "wheel" | "assisted" | undefined
  };
}

function parseUpdateCheckinBody(body: unknown): UpdateCheckinInput {
  const value = requireObject(body);
  const feelingCore = value["feelingCore"];
  if (!isFeelingCore(feelingCore)) {
    throw new HttpError(400, `feelingCore must be one of ${WELLNESS_EMOTION_CORES.join(", ")}`);
  }
  const feelingSecondary = optionalNullableString(value["feelingSecondary"], "feelingSecondary");
  const feelingTertiary = optionalNullableString(value["feelingTertiary"], "feelingTertiary");
  if (!isValidFeelingPath(feelingCore, feelingSecondary ?? null, feelingTertiary ?? null)) {
    throw new HttpError(
      400,
      "feelingSecondary/feelingTertiary must form a valid path under feelingCore"
    );
  }
  const intensity = value["intensity"];
  if (intensity !== undefined && intensity !== null) {
    if (
      typeof intensity !== "number" ||
      !Number.isInteger(intensity) ||
      intensity < 1 ||
      intensity > 5
    ) {
      throw new HttpError(400, "intensity must be an integer from 1 to 5");
    }
  }
  const energy = value["energy"];
  if (energy !== undefined && energy !== null) {
    if (typeof energy !== "number" || !Number.isInteger(energy) || energy < 1 || energy > 5) {
      throw new HttpError(400, "energy must be an integer from 1 to 5");
    }
  }
  return {
    feelingCore,
    feelingSecondary,
    // Omitted sensations → undefined (preserve existing); explicit [] → clear; non-empty → set.
    sensations: parseOptionalStringArray(value["sensations"], "sensations"),
    intensity: intensity === undefined ? undefined : (intensity as number | null),
    energy: energy === undefined ? undefined : (energy as number | null),
    note: optionalNullableString(value["note"], "note")
  };
}

function parseLogDoseBody(body: unknown): LogDoseInput {
  const value = requireObject(body);
  const status = value["status"];
  if (!isLogStatus(status)) {
    throw new HttpError(400, `status must be one of ${MEDICATION_LOG_STATUSES.join(", ")}`);
  }
  const prnReason = optionalNullableString(value["prnReason"], "prnReason");
  const scheduledFor = optionalNullableString(value["scheduledFor"], "scheduledFor");
  // Non-PRN logs satisfy a scheduled slot — reject at the route (friendly 400) rather than
  // letting the DB CHECK surface a 500 (Codex R2).
  if (status !== "prn" && !scheduledFor) {
    throw new HttpError(400, "scheduledFor is required for taken/skipped doses");
  }
  // PRN doses are unscheduled by definition (scheduled_for IS NULL — repository.logDose does a
  // plain insert for them). A "prn" log carrying a scheduledFor would instead take the
  // scheduled-dose upsert path and CLOBBER the prior taken/skipped record for that slot,
  // regressing it to "pending" in the schedule view (#770 / M3). Reject before it reaches the
  // repository.
  if (status === "prn" && scheduledFor) {
    throw new HttpError(400, "scheduledFor must not be set for prn doses");
  }
  return {
    status,
    dose: optionalNullableString(value["dose"], "dose"),
    prnReason,
    scheduledFor
  };
}

function parseTherapyNoteBody(body: unknown): CreateTherapyNoteInput {
  const value = requireObject(body);
  const bodyText = requiredString(value["body"], "body");
  const linkedCheckinId =
    value["linkedCheckinId"] === undefined
      ? undefined
      : value["linkedCheckinId"] === null
        ? null
        : typeof value["linkedCheckinId"] === "string"
          ? value["linkedCheckinId"]
          : (() => {
              throw new HttpError(400, "linkedCheckinId must be a UUID string or null");
            })();
  const linkedEmotion =
    value["linkedEmotion"] === undefined
      ? undefined
      : value["linkedEmotion"] === null
        ? null
        : isFeelingCore(value["linkedEmotion"])
          ? (value["linkedEmotion"] as WellnessFeelingCore)
          : (() => {
              throw new HttpError(
                400,
                `linkedEmotion must be one of ${WELLNESS_EMOTION_CORES.join(", ")}`
              );
            })();
  return { body: bodyText, linkedCheckinId, linkedEmotion };
}

function parseSinceDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return 30;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new HttpError(400, "sinceDays must be 1–90");
  return n;
}

function isFeelingCore(value: unknown): value is WellnessFeelingCore {
  return typeof value === "string" && (WELLNESS_EMOTION_CORES as readonly string[]).includes(value);
}
function isLogStatus(value: unknown): value is MedicationLogStatusApi {
  return (
    typeof value === "string" && (MEDICATION_LOG_STATUSES as readonly string[]).includes(value)
  );
}

function parseSince(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "since must be an ISO timestamp");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "since must be an ISO timestamp");
  return date;
}
function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, "limit must be 1–500");
  return n;
}
function parseDateParam(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "date must be an ISO date (YYYY-MM-DD)");
  }
  return value;
}
