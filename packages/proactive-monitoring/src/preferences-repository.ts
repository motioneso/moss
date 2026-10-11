import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

function jsonb(value: unknown) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}
import {
  PROACTIVE_MONITORING_PREFERENCE_KEY,
  defaultProactiveMonitoringPreference,
  type ProactiveMonitoringPreferenceV1,
  type ProactiveSource,
  type ProactiveSourcePreference
} from "@moss/shared";

const VALID_SOURCES = new Set<ProactiveSource>(["tasks", "calendar", "email", "notes"]);
const PREF_KEYS = new Set([
  "version",
  "automaticEmailAlerts",
  "enabled",
  "sources",
  "dailyCardCap",
  "quietHours",
  "updatedAt"
]);
const QUIET_HOURS_KEYS = new Set(["enabled", "startLocalTime", "endLocalTime"]);
const SOURCE_PREF_KEYS = new Set(["enabled", "dailyCardCap"]);

export class ProactivePreferenceRevisionConflictError extends Error {
  constructor() {
    super(`Preference "${PROACTIVE_MONITORING_PREFERENCE_KEY}" was modified concurrently`);
    this.name = "ProactivePreferenceRevisionConflictError";
  }
}

export interface SavedProactiveMonitoringPreference {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly preference: ProactiveMonitoringPreferenceV1;
  readonly hasLegacyEmailChoice: boolean;
}

export class ProactiveMonitoringPreferencesRepository {
  async get(scopedDb: DataContextDb): Promise<ProactiveMonitoringPreferenceV1> {
    const saved = await this.getSaved(scopedDb);
    return saved?.preference ?? defaultProactiveMonitoringPreference();
  }

  async getSaved(
    scopedDb: DataContextDb
  ): Promise<SavedProactiveMonitoringPreference | null | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.preferences")
      .select("value_json")
      .where("key", "=", PROACTIVE_MONITORING_PREFERENCE_KEY)
      .executeTakeFirst();
    if (!row) return undefined;
    try {
      return parse(row.value_json);
    } catch {
      return null;
    }
  }

  /**
   * Read for a compare-and-set writer. forUpdate locks the row. `saved` is null when the stored
   * record is malformed.
   */
  async getSavedWithRevision(
    scopedDb: DataContextDb,
    options: { readonly forUpdate?: boolean } = {}
  ): Promise<
    | { readonly saved: SavedProactiveMonitoringPreference | null; readonly revision: number }
    | undefined
  > {
    assertDataContextDb(scopedDb);
    let query = scopedDb.db
      .selectFrom("app.preferences")
      .select(["value_json", "revision"])
      .where("key", "=", PROACTIVE_MONITORING_PREFERENCE_KEY);
    if (options.forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) return undefined;
    let saved: SavedProactiveMonitoringPreference | null;
    try {
      saved = parse(row.value_json);
    } catch {
      saved = null;
    }
    return { saved, revision: row.revision };
  }

  /**
   * Compare-and-set write. A null expectation inserts only when no row exists; otherwise the row
   * must still be at `expectedRevision`. Either miss throws ProactivePreferenceRevisionConflictError.
   * Keep in step with PreferencesRepository.upsertWithRevision in @moss/structured-state.
   */
  async upsertWithRevision(
    scopedDb: DataContextDb,
    value: Record<string, unknown>,
    expectedRevision: number | null
  ): Promise<SavedProactiveMonitoringPreference & { readonly revision: number }> {
    assertDataContextDb(scopedDb);
    const saved = parse(value);
    const row =
      expectedRevision === null
        ? await scopedDb.db
            .insertInto("app.preferences")
            .values({
              owner_user_id: sql<string>`app.current_actor_user_id()`,
              key: PROACTIVE_MONITORING_PREFERENCE_KEY,
              value_json: jsonb(value),
              revision: 1,
              updated_at: new Date()
            })
            .onConflict((oc) => oc.columns(["owner_user_id", "key"]).doNothing())
            .returning("revision")
            .executeTakeFirst()
        : await scopedDb.db
            .updateTable("app.preferences")
            .set({
              value_json: jsonb(value),
              revision: expectedRevision + 1,
              updated_at: new Date()
            })
            .where("key", "=", PROACTIVE_MONITORING_PREFERENCE_KEY)
            .where("revision", "=", expectedRevision)
            .returning("revision")
            .executeTakeFirst();
    if (!row) throw new ProactivePreferenceRevisionConflictError();
    return { ...saved, revision: row.revision };
  }

  async initializeAutomaticEmailAlerts(
    scopedDb: DataContextDb
  ): Promise<SavedProactiveMonitoringPreference | null | undefined> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.preferences")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        key: PROACTIVE_MONITORING_PREFERENCE_KEY,
        value_json: jsonb({
          version: 1,
          automaticEmailAlerts: true,
          updatedAt: new Date().toISOString()
        }),
        updated_at: new Date()
      })
      .onConflict((oc) => oc.columns(["owner_user_id", "key"]).doNothing())
      .execute();
    return this.getSaved(scopedDb);
  }
}

export function validateProactiveMonitoringPreference(
  input: unknown
): asserts input is ProactiveMonitoringPreferenceV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Invalid preference: must be an object");
  }
  const p = input as Record<string, unknown>;

  const unknownKeys = Object.keys(p).filter((k) => !PREF_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new HttpError(400, `Unknown preference keys: ${unknownKeys.join(", ")}`);
  }
  if (p.version !== 1) {
    throw new HttpError(400, "Invalid preference: version must be 1");
  }
  if (p.automaticEmailAlerts !== undefined && typeof p.automaticEmailAlerts !== "boolean") {
    throw new HttpError(400, "Invalid preference: automaticEmailAlerts must be boolean");
  }
  if (typeof p.enabled !== "boolean") {
    throw new HttpError(400, "Invalid preference: enabled must be boolean");
  }
  if (typeof p.dailyCardCap !== "number" || p.dailyCardCap < 1 || p.dailyCardCap > 20) {
    throw new HttpError(400, "Invalid preference: dailyCardCap must be 1–20");
  }
  if (!p.sources || typeof p.sources !== "object" || Array.isArray(p.sources)) {
    throw new HttpError(400, "Invalid preference: sources must be an object");
  }
  const sources = p.sources as Record<string, unknown>;
  for (const src of VALID_SOURCES) {
    const sp = sources[src];
    if (!sp || typeof sp !== "object" || Array.isArray(sp)) {
      throw new HttpError(400, `Invalid preference: sources.${src} must be an object`);
    }
    const s = sp as Record<string, unknown>;
    const unknownSrcKeys = Object.keys(s).filter((k) => !SOURCE_PREF_KEYS.has(k));
    if (unknownSrcKeys.length > 0) {
      throw new HttpError(400, `Unknown source preference keys: ${unknownSrcKeys.join(", ")}`);
    }
    if (typeof s.enabled !== "boolean") {
      throw new HttpError(400, `Invalid preference: sources.${src}.enabled must be boolean`);
    }
    if (
      typeof s.dailyCardCap !== "number" ||
      (s.dailyCardCap as number) < 1 ||
      (s.dailyCardCap as number) > 5
    ) {
      throw new HttpError(400, `Invalid preference: sources.${src}.dailyCardCap must be 1–5`);
    }
  }
  const extraSrcKeys = Object.keys(sources).filter((k) => !VALID_SOURCES.has(k as ProactiveSource));
  if (extraSrcKeys.length > 0) {
    throw new HttpError(400, `Unknown sources: ${extraSrcKeys.join(", ")}`);
  }
  if (!p.quietHours || typeof p.quietHours !== "object" || Array.isArray(p.quietHours)) {
    throw new HttpError(400, "Invalid preference: quietHours must be an object");
  }
  const qh = p.quietHours as Record<string, unknown>;
  const unknownQhKeys = Object.keys(qh).filter((k) => !QUIET_HOURS_KEYS.has(k));
  if (unknownQhKeys.length > 0) {
    throw new HttpError(400, `Unknown quietHours keys: ${unknownQhKeys.join(", ")}`);
  }
  if (typeof qh.enabled !== "boolean") {
    throw new HttpError(400, "Invalid preference: quietHours.enabled must be boolean");
  }
  if (typeof qh.startLocalTime !== "string" || !isLocalTime(qh.startLocalTime)) {
    throw new HttpError(400, "Invalid preference: quietHours.startLocalTime must be HH:MM");
  }
  if (typeof qh.endLocalTime !== "string" || !isLocalTime(qh.endLocalTime)) {
    throw new HttpError(400, "Invalid preference: quietHours.endLocalTime must be HH:MM");
  }
  if (typeof p.updatedAt !== "string") {
    throw new HttpError(400, "Invalid preference: updatedAt must be a string");
  }
}

/** Parses a stored record the way the repository reads it. Null means the record is malformed. */
export function parseProactiveMonitoringPreference(
  raw: unknown
): SavedProactiveMonitoringPreference | null {
  try {
    return parse(raw);
  } catch {
    return null;
  }
}

function parse(raw: unknown): SavedProactiveMonitoringPreference {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("malformed preference");
  }
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) throw new Error("malformed preference");
  const defaults = defaultProactiveMonitoringPreference();
  const sources = p.sources;
  const quietHours = p.quietHours;
  if (
    sources !== undefined &&
    (!sources || typeof sources !== "object" || Array.isArray(sources))
  ) {
    throw new Error("malformed preference");
  }
  if (
    quietHours !== undefined &&
    (!quietHours || typeof quietHours !== "object" || Array.isArray(quietHours))
  ) {
    throw new Error("malformed preference");
  }
  const effectiveSources = { ...defaults.sources } as Record<string, unknown>;
  for (const [source, value] of Object.entries(sources ?? {})) {
    effectiveSources[source] =
      value && typeof value === "object" && !Array.isArray(value) && source in effectiveSources
        ? { ...(effectiveSources[source] as Record<string, unknown>), ...value }
        : value;
  }
  const preference = {
    ...defaults,
    ...p,
    sources: effectiveSources,
    quietHours: { ...defaults.quietHours, ...(quietHours ?? {}) }
  };
  validateProactiveMonitoringPreference(preference);
  return {
    raw: p,
    preference,
    hasLegacyEmailChoice:
      "enabled" in p || (Boolean(sources) && "email" in (sources as Record<string, unknown>))
  };
}

function isLocalTime(s: string): boolean {
  return /^\d{2}:\d{2}$/.test(s);
}

export function resolveSourcePreference(
  pref: ProactiveMonitoringPreferenceV1,
  source: ProactiveSource
): ProactiveSourcePreference {
  return pref.sources[source] ?? { enabled: false, dailyCardCap: 3 };
}

/**
 * `undefined` means no stored record, while `null` is a malformed stored record.
 * Legacy records preserve their master/source-off decisions until the user saves an
 * explicit email choice.
 */
export function resolveAutomaticEmailAlertsEnabled(
  saved: SavedProactiveMonitoringPreference | null | undefined
): boolean {
  if (saved === undefined) return true;
  if (saved === null) return false;
  if (typeof saved.preference.automaticEmailAlerts === "boolean") {
    return saved.preference.automaticEmailAlerts;
  }
  return saved.hasLegacyEmailChoice
    ? saved.preference.enabled && saved.preference.sources.email.enabled
    : true;
}

export function isProactiveSourceEnabled(
  preference: ProactiveMonitoringPreferenceV1,
  source: ProactiveSource,
  saved: SavedProactiveMonitoringPreference | null | undefined
): boolean {
  return source === "email"
    ? resolveAutomaticEmailAlertsEnabled(saved)
    : preference.enabled && Boolean(preference.sources[source]?.enabled);
}
