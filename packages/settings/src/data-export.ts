import type { Kysely, sql } from "kysely";

import {
  assertQualifiedTableName,
  createModuleStorageRpc,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";

import {
  aiAssistantActionRequestsQuery,
  aiConfiguredModelsQuery,
  aiProviderConfigsQuery,
  authAccountsQuery,
  betterAuthSessionsQuery,
  briefingDefinitionsQuery,
  briefingRunsQuery,
  calendarEventsQuery,
  chatMemoryFactsQuery,
  chatMessagesQuery,
  chatThreadsQuery,
  commitmentsQuery,
  connectorAccountsQuery,
  emailMessagesQuery,
  entitiesQuery,
  jarvisActionAuditLogQuery,
  jarvisGoalEvidenceQuery,
  jarvisGoalsQuery,
  medicationLogsQuery,
  medicationsQuery,
  memoryAliasesQuery,
  memoryCandidatesQuery,
  memoryChunksQuery,
  memoryConflictGroupsQuery,
  memoryEntitiesQuery,
  memoryEpisodesQuery,
  memoryFactSourcesQuery,
  memoryFactsQuery,
  memoryLegacyFactMigrationsQuery,
  memorySearchDocumentsQuery,
  moduleCredentialsQuery,
  moduleKvQuery,
  notificationReadsQuery,
  notificationsQuery,
  preferencesQuery,
  taskActivityQuery,
  tasksQuery,
  usefulnessFeedbackSignalsQuery,
  usefulnessFeedbackTargetsQuery,
  userQuery
} from "./data-export-queries.js";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type ExportRow = Record<string, JsonValue>;

/** Shape returned by the news module's newsPersonalization export-section collector (#953). */
export interface NewsPersonalizationExportSection {
  readonly custom_sources: readonly ExportRow[];
  readonly custom_topics: readonly ExportRow[];
  readonly source_exclusions: readonly ExportRow[];
}

export interface SportsSourcesExportSection {
  readonly assignments: readonly ExportRow[];
  readonly sources: readonly ExportRow[];
}

export interface ExportUserDataOptions {
  readonly scopedDb: DataContextDb;
  readonly authDb: Kysely<MossDatabase>;
  readonly exportedAt?: Date;
  readonly userId: string;
  /**
   * Supplies the built-in + custom module manifests so this function can invoke a migrated
   * module's `dataLifecycle.exportSections` collectors (#801 Phase A) instead of reading that
   * module's tables directly. Required — every call site derives it from the same
   * `listModuleManifests` DI seam already threaded through settings' composition root (avoids
   * a package cycle: @moss/settings cannot statically import @moss/wellness).
   */
  readonly listModuleManifests: () => readonly MossModuleManifest[];
  /** Passed to a module's export-section collect() as ModuleLifecycleContext.requestId. */
  readonly requestId?: string;
}

export interface UserDataExport {
  readonly exportedAt: string;
  readonly tables: UserDataExportTables;
  readonly userId: string;
}

export interface UserDataExportTables {
  readonly aiAssistantActionRequests: readonly ExportRow[];
  readonly aiConfiguredModels: readonly ExportRow[];
  readonly aiProviderConfigs: readonly ExportRow[];
  readonly authAccounts: readonly ExportRow[];
  readonly betterAuthSessions: readonly ExportRow[];
  readonly briefingDefinitions: readonly ExportRow[];
  readonly briefingRuns: readonly ExportRow[];
  readonly calendarEvents: readonly ExportRow[];
  readonly chatMemoryFacts: readonly ExportRow[];
  readonly chatMessages: readonly ExportRow[];
  readonly chatThreads: readonly ExportRow[];
  readonly commitments: readonly ExportRow[];
  readonly connectorAccounts: readonly ExportRow[];
  readonly emailMessages: readonly ExportRow[];
  readonly entities: readonly ExportRow[];
  readonly medicationLogs: readonly ExportRow[];
  readonly medications: readonly ExportRow[];
  readonly memoryChunks: readonly ExportRow[];
  readonly memoryAliases: readonly ExportRow[];
  readonly memoryCandidates: readonly ExportRow[];
  readonly memoryConflictGroups: readonly ExportRow[];
  readonly memoryEntities: readonly ExportRow[];
  readonly memoryEpisodes: readonly ExportRow[];
  readonly memoryFacts: readonly ExportRow[];
  readonly memoryFactSources: readonly ExportRow[];
  readonly memoryLegacyFactMigrations: readonly ExportRow[];
  readonly moduleCredentials: readonly ExportRow[];
  readonly moduleKv: readonly ExportRow[];
  /**
   * #953 Task 6: nested News personalization section collected via the news module's
   * dataLifecycle.exportSections seam (like wellness). One explicit field, not a generalized
   * module loop — the exporter stays hand-assembled in this slice. Contains only user-authored
   * preferences; compilation snapshots and validation fingerprints are excluded by the
   * collector (pinned in tests/integration/data-export.test.ts).
   */
  readonly newsPersonalization: NewsPersonalizationExportSection;
  readonly memorySearchDocuments: readonly ExportRow[];
  readonly notificationReads: readonly ExportRow[];
  readonly notifications: readonly ExportRow[];
  readonly preferences: readonly ExportRow[];
  readonly sportsSources: SportsSourcesExportSection;
  readonly taskActivity: readonly ExportRow[];
  readonly tasks: readonly ExportRow[];
  readonly usefulnessFeedbackSignals: readonly ExportRow[];
  readonly usefulnessFeedbackTargets: readonly ExportRow[];
  readonly users: readonly ExportRow[];
  readonly wellnessCheckins: readonly ExportRow[];
  readonly wellnessTherapyNotes: readonly ExportRow[];
  readonly jarvisActionAuditLog: readonly ExportRow[];
  readonly jarvisGoals: readonly ExportRow[];
  readonly jarvisGoalEvidence: readonly ExportRow[];
}

export async function exportUserData(options: ExportUserDataOptions): Promise<UserDataExport> {
  const exportedAt = (options.exportedAt ?? new Date()).toISOString();

  return {
    exportedAt,
    userId: options.userId,
    tables: await readExportTables(
      options.scopedDb,
      options.authDb,
      options.userId,
      options.listModuleManifests,
      options.requestId ?? `export:${options.userId}`
    )
  };
}

/**
 * Looks up a migrated module's declared export section and runs its collect() under the
 * caller's own DataContextDb (#801 Phase A). Throws if the module or section is missing —
 * a manifest wiring bug, not a runtime/user condition — so it surfaces loudly rather than
 * silently omitting data from an account export.
 */
async function collectModuleExportSection<T>(
  listModuleManifests: () => readonly MossModuleManifest[],
  moduleId: string,
  sectionKey: string,
  scopedDb: DataContextDb,
  ctx: { readonly actorUserId: string; readonly requestId: string }
): Promise<T> {
  const manifest = listModuleManifests().find((candidate) => candidate.id === moduleId);
  const section = manifest?.dataLifecycle?.exportSections?.find(
    (candidate) => candidate.key === sectionKey
  );
  if (!section) {
    throw new Error(
      `No dataLifecycle export section "${sectionKey}" declared by module "${moduleId}"`
    );
  }
  return (await section.collect(scopedDb, ctx)) as T;
}

/**
 * External-module counterpart to collectModuleExportSection (#914, spec D6). External modules
 * carry no `collect()` code in their manifest (a function can't survive JSON), so instead of
 * calling a declared export section, this dumps every row from each declared owned table directly
 * — via createModuleStorageRpc (Task 8), the same SET LOCAL ROLE jarvis_mod_<slug>_runtime path a
 * module's own code would use. That scopes each read under the module's RLS-narrowed grant, not
 * the caller's parent runtime role, so the result is exactly what the module itself could see.
 */
export async function readExternalModuleExportRows(
  scopedDb: DataContextDb,
  installedManifests: readonly MossModuleManifest[]
): Promise<Record<string, readonly ExportRow[]>> {
  const rowsByTable: Record<string, readonly ExportRow[]> = {};
  for (const manifest of installedManifests) {
    const rpc = createModuleStorageRpc(scopedDb, manifest.id, {
      // Export must return every row of every owned table — the interactive
      // caps (5s / 5000 rows / 5 MiB, #1167) would truncate large exports.
      // The allowlist and redaction stay on; the statement here is a SELECT.
      statementTimeoutMs: null,
      rowCap: null,
      resultByteCap: null
    });
    for (const table of manifest.database?.ownedTables ?? []) {
      assertQualifiedTableName(table);
      const result = await rpc.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`);
      rowsByTable[table] = result.rows.map(normalizeRow);
    }
  }
  return rowsByTable;
}

async function readExportTables(
  scopedDb: DataContextDb,
  authDb: Kysely<MossDatabase>,
  userId: string,
  listModuleManifests: () => readonly MossModuleManifest[],
  requestId: string
): Promise<UserDataExportTables> {
  const wellnessSection = await collectModuleExportSection<{
    readonly checkins: readonly ExportRow[];
    readonly therapy_notes: readonly ExportRow[];
  }>(listModuleManifests, "wellness", "wellness", scopedDb, {
    actorUserId: userId,
    requestId
  });

  const newsPersonalizationSection =
    await collectModuleExportSection<NewsPersonalizationExportSection>(
      listModuleManifests,
      "news",
      "newsPersonalization",
      scopedDb,
      { actorUserId: userId, requestId }
    );

  const sportsSourcesSection = await collectModuleExportSection<SportsSourcesExportSection>(
    listModuleManifests,
    "sports",
    "sportsSources",
    scopedDb,
    { actorUserId: userId, requestId }
  );

  return {
    users: await readRows(scopedDb.db, userQuery(userId)),
    authAccounts: await readRows(authDb, authAccountsQuery(userId)),
    betterAuthSessions: await readRows(authDb, betterAuthSessionsQuery(userId)),
    tasks: await readRows(scopedDb.db, tasksQuery(userId)),
    taskActivity: await readRows(scopedDb.db, taskActivityQuery(userId)),
    notifications: await readRows(scopedDb.db, notificationsQuery(userId)),
    notificationReads: await readRows(scopedDb.db, notificationReadsQuery(userId)),
    connectorAccounts: await readRows(scopedDb.db, connectorAccountsQuery(userId)),
    moduleCredentials: await readRows(scopedDb.db, moduleCredentialsQuery(userId)),
    moduleKv: await readRows(scopedDb.db, moduleKvQuery(userId)),
    calendarEvents: await readRows(scopedDb.db, calendarEventsQuery(userId)),
    emailMessages: await readRows(scopedDb.db, emailMessagesQuery(userId)),
    aiProviderConfigs: await readRows(scopedDb.db, aiProviderConfigsQuery(userId)),
    aiConfiguredModels: await readRows(scopedDb.db, aiConfiguredModelsQuery(userId)),
    aiAssistantActionRequests: await readRows(scopedDb.db, aiAssistantActionRequestsQuery(userId)),
    jarvisActionAuditLog: await readRows(scopedDb.db, jarvisActionAuditLogQuery(userId)),
    chatThreads: await readRows(scopedDb.db, chatThreadsQuery(userId)),
    chatMessages: await readRows(scopedDb.db, chatMessagesQuery(userId)),
    briefingDefinitions: await readRows(scopedDb.db, briefingDefinitionsQuery(userId)),
    briefingRuns: await readRows(scopedDb.db, briefingRunsQuery(userId)),
    memoryChunks: await readRows(scopedDb.db, memoryChunksQuery(userId)),
    jarvisGoals: await readRows(scopedDb.db, jarvisGoalsQuery(userId)),
    jarvisGoalEvidence: await readRows(scopedDb.db, jarvisGoalEvidenceQuery(userId)),
    chatMemoryFacts: await readRows(scopedDb.db, chatMemoryFactsQuery(userId)),
    memoryEntities: await readRows(scopedDb.db, memoryEntitiesQuery(userId)),
    memoryFacts: await readRows(scopedDb.db, memoryFactsQuery(userId)),
    memoryEpisodes: await readRows(scopedDb.db, memoryEpisodesQuery(userId)),
    memoryFactSources: await readRows(scopedDb.db, memoryFactSourcesQuery(userId)),
    memoryAliases: await readRows(scopedDb.db, memoryAliasesQuery(userId)),
    memoryCandidates: await readRows(scopedDb.db, memoryCandidatesQuery(userId)),
    memoryConflictGroups: await readRows(scopedDb.db, memoryConflictGroupsQuery(userId)),
    memorySearchDocuments: await readRows(scopedDb.db, memorySearchDocumentsQuery(userId)),
    memoryLegacyFactMigrations: await readRows(
      scopedDb.db,
      memoryLegacyFactMigrationsQuery(userId)
    ),
    commitments: await readRows(scopedDb.db, commitmentsQuery(userId)),
    entities: await readRows(scopedDb.db, entitiesQuery(userId)),
    preferences: await readRows(scopedDb.db, preferencesQuery(userId)),
    sportsSources: sportsSourcesSection,
    usefulnessFeedbackSignals: await readRows(scopedDb.db, usefulnessFeedbackSignalsQuery(userId)),
    usefulnessFeedbackTargets: await readRows(scopedDb.db, usefulnessFeedbackTargetsQuery(userId)),
    newsPersonalization: newsPersonalizationSection,
    wellnessCheckins: wellnessSection.checkins,
    medications: await readRows(scopedDb.db, medicationsQuery(userId)),
    medicationLogs: await readRows(scopedDb.db, medicationLogsQuery(userId)),
    wellnessTherapyNotes: wellnessSection.therapy_notes
  };
}

async function readRows(
  db: Kysely<MossDatabase>,
  query: ReturnType<typeof sql<Record<string, unknown>>>
): Promise<ExportRow[]> {
  const result = await query.execute(db);

  return result.rows.map(normalizeRow);
}

function normalizeRow(row: Record<string, unknown>): ExportRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  ) as ExportRow;
}

function normalizeValue(value: unknown): JsonValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeValue(nested)
      ])
    );
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  return String(value);
}
