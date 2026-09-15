import { randomUUID } from "node:crypto";

import { sql, type Updateable } from "kysely";

import { findAssistantToolFromManifests } from "@moss/ai";
import {
  assertDataContextDb,
  type BriefingCadence,
  type BriefingDefinition,
  type BriefingDefinitionsTable,
  type BriefingRun,
  type BriefingRunKind,
  type BriefingRunStatus,
  type BriefingType,
  type DataContextDb
} from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";

import { composeBriefing, sourceIncludedInBriefings, type ComposeDeps } from "./compose.js";
import { emptyStructuredPayload } from "./action-rows.js";
import { defaultScheduleMetadataFor, timezoneFor } from "./schedule.js";
import type { BriefingStructuredPayloadV1 } from "@moss/shared";

export interface CreateBriefingDefinitionInput {
  readonly title: string;
  readonly briefingType?: BriefingType;
  readonly cadence?: BriefingCadence;
  readonly scheduleMetadata?: Record<string, unknown>;
  readonly enabled?: boolean;
  readonly selectedToolNames: readonly string[];
}

export interface UpdateBriefingDefinitionInput {
  readonly title?: string;
  readonly briefingType?: BriefingType;
  readonly cadence?: BriefingCadence;
  readonly scheduleMetadata?: Record<string, unknown>;
  readonly enabled?: boolean;
  readonly selectedToolNames?: readonly string[];
}

export interface GenerateBriefingRunInput {
  readonly moduleManifests: readonly MossModuleManifest[];
  readonly runKind: BriefingRunKind;
  readonly runId?: string;
  /**
   * pg-boss job ID when this run is triggered by a worker job.
   * Used to form the requestId in ToolContext so execution is traceable.
   */
  readonly jobId?: string;
  /**
   * Synthesis dependencies (AI repository, credential cipher, memory retriever,
   * module manifests). Required — the only production caller is the briefings
   * worker, which always builds these. The deterministic degraded fallback lives
   * inside `compose.ts`, so there is no provider-less variant here.
   */
  readonly composeDeps: ComposeDeps;
  /**
   * Automatic plan-effect port (R2.3-T06). When present and composition
   * succeeded, the plan step reserves day-plan blocks and an apply batch in
   * this same transaction through public repository methods. Structural on
   * purpose: briefings never imports the calendar package (module
   * isolation); the composition root adapts the calendar implementation.
   */
  readonly dayPlanAuto?: BriefingDayPlanAutoPort;
}

// One automatic plan effect per briefing signal, structurally matching the
// calendar module's AutoPlanSignal (no cross-package import).
export interface BriefingAutoSignal {
  readonly type?: string;
  readonly summary: string;
  readonly suggestedActions: readonly string[];
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly followThrough?: {
    readonly targetRef: string;
    readonly taskId?: string;
    readonly intents?: readonly {
      readonly kind: "create_task" | "block_time";
      readonly targetRef: string;
      readonly title: string;
      readonly window?: {
        readonly start: string;
        readonly end: string;
        readonly durationMinutes: number;
      };
    }[];
  };
}

export interface BriefingAutoPlanResult {
  readonly planId: string;
  readonly autoBlockIds: readonly string[];
  readonly suggestBlockIds: readonly string[];
  readonly operationId: string | null;
  readonly batchKey: string | null;
  readonly revisionRace: boolean;
}

export interface BriefingDayPlanAutoPort {
  reserveAutoPlan(
    scopedDb: DataContextDb,
    input: {
      readonly runId: string;
      readonly definitionId: string;
      readonly localDay: string;
      readonly timeZone: string;
      readonly signals: readonly BriefingAutoSignal[];
    }
  ): Promise<BriefingAutoPlanResult | null>;
  findUnfinishedBatch(
    scopedDb: DataContextDb,
    input: { planId: string; batchKey: string }
  ): Promise<{ operationId: string } | undefined>;
}

export interface GenerateBriefingRunOutcome {
  readonly run: BriefingRun;
  readonly created: boolean;
  // Present when the generation plan step reserved an apply batch that still
  // needs the apply job (fresh auto runs and resumed duplicates).
  readonly auto?: {
    readonly planId: string;
    readonly operationId: string;
    readonly batchKey: string;
  } | null;
}

export class BriefingsRepository {
  async listDefinitions(scopedDb: DataContextDb): Promise<BriefingDefinition[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.briefing_definitions")
      .selectAll()
      .orderBy("updated_at", "desc")
      .orderBy("id")
      .execute();
  }

  async getDefinitionById(
    scopedDb: DataContextDb,
    definitionId: string
  ): Promise<BriefingDefinition | undefined> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.briefing_definitions")
      .selectAll()
      .where("id", "=", definitionId)
      .executeTakeFirst();
  }

  async createDefinition(
    scopedDb: DataContextDb,
    input: CreateBriefingDefinitionInput
  ): Promise<BriefingDefinition> {
    assertDataContextDb(scopedDb);

    const now = new Date();
    const briefingType = input.briefingType ?? "morning";

    return scopedDb.db
      .insertInto("app.briefing_definitions")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        title: input.title,
        briefing_type: briefingType,
        cadence: input.cadence ?? "manual",
        schedule_metadata: input.scheduleMetadata ?? defaultScheduleMetadataFor(briefingType),
        enabled: input.enabled ?? true,
        selected_tool_names: [...input.selectedToolNames],
        last_run_at: null,
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateDefinition(
    scopedDb: DataContextDb,
    definitionId: string,
    input: UpdateBriefingDefinitionInput
  ): Promise<BriefingDefinition | undefined> {
    assertDataContextDb(scopedDb);

    const updates: Updateable<BriefingDefinitionsTable> = {
      updated_at: new Date()
    };

    if (input.title !== undefined) {
      updates.title = input.title;
    }
    if (input.briefingType !== undefined) {
      updates.briefing_type = input.briefingType;
    }
    if (input.cadence !== undefined) {
      updates.cadence = input.cadence;
    }
    if (input.scheduleMetadata !== undefined) {
      updates.schedule_metadata = input.scheduleMetadata;
    }
    if (input.enabled !== undefined) {
      updates.enabled = input.enabled;
    }
    if (input.selectedToolNames !== undefined) {
      updates.selected_tool_names = [...input.selectedToolNames];
    }

    return scopedDb.db
      .updateTable("app.briefing_definitions")
      .set(updates)
      .where("id", "=", definitionId)
      .returningAll()
      .executeTakeFirst();
  }

  async listRuns(scopedDb: DataContextDb, definitionId: string): Promise<BriefingRun[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.briefing_runs")
      .selectAll()
      .where("definition_id", "=", definitionId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
  }

  async getOwnedRunById(scopedDb: DataContextDb, runId: string): Promise<BriefingRun | undefined> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.briefing_runs")
      .selectAll()
      .where("id", "=", runId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
  }

  async getOwnedEveningRunForInterview(
    scopedDb: DataContextDb,
    runId?: string
  ): Promise<BriefingRun | undefined> {
    assertDataContextDb(scopedDb);

    let query = scopedDb.db
      .selectFrom("app.briefing_runs")
      .selectAll()
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("briefing_type", "=", "evening");
    if (runId) {
      query = query.where("id", "=", runId);
    }

    return query.orderBy("created_at", "desc").orderBy("id").executeTakeFirst();
  }

  /** `created:false` means an existing same-day scheduled run was returned (idempotent skip). */
  async generateRun(
    scopedDb: DataContextDb,
    definitionId: string,
    input: GenerateBriefingRunInput
  ): Promise<GenerateBriefingRunOutcome | undefined> {
    assertDataContextDb(scopedDb);

    const definition = await this.getOwnedDefinitionById(scopedDb, definitionId);
    if (!definition) {
      return undefined;
    }

    // Capture ONE `now` so the lock-day, the existing-run comparison, and compose's
    // local-day window all agree even across a local-midnight boundary.
    const now = new Date();
    // Mint ONE run id so the persisted run and the automatic batch key agree.
    const runId = input.runId ?? randomUUID();

    // Scheduled local-day idempotency under a transaction-scoped advisory lock so two
    // concurrent cron fires (multi-replica worker, or a retry overlapping the first)
    // cannot both pass check-then-insert (F2). `scopedDb.db` is ALREADY the Kysely
    // Transaction opened by withDataContext (DataContextDb.db: Transaction<...>), so we
    // take the lock ON that existing transaction — do NOT open a nested transaction. The
    // lock auto-releases when withDataContext's transaction commits/rolls back.
    //
    // This runs BEFORE the blocked-tool guard so a blocked SCHEDULED definition is also
    // deduped: the idempotency check matches any same-local-day scheduled run regardless
    // of status, so a persisted `blocked` run suppresses every later fire that day rather
    // than orphaning a fresh blocked row on each cron tick.
    if (input.runKind === "scheduled") {
      // hashtextextended(text, 0) → stable bigint key per (definition, local day).
      const lockKey = `${definition.id}:${localPeriodString(definition, now)}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(scopedDb.db);
      const existing = await this.findScheduledRunForLocalPeriod(scopedDb, definition, now);
      if (existing) {
        return {
          run: existing,
          created: false,
          auto: await this.resumeAutoBatch(scopedDb, input, existing)
        };
      }
    }

    const blocked = definition.selected_tool_names.some((name) => {
      if (name === "vault" || name === "chats") return false;
      const tool = findAssistantToolFromManifests(input.composeDeps.moduleManifests, name);
      return !tool || tool.risk !== "read";
    });
    if (blocked) {
      const run = await this.persistRun(scopedDb, definition, input, runId, {
        status: "blocked",
        summaryText: "Briefing blocked because selected tools are not all declared read tools.",
        sourceMetadata: { degraded: false, gaps: [], blockedReason: "non_read_tool" },
        structuredPayload: emptyStructuredPayload()
      });
      return { run, created: true, auto: null };
    }

    let sameDayMorningMeta: Record<string, unknown> | null = null;
    if (definition.briefing_type === "evening") {
      try {
        const morningRun = await this.findSameLocalDayMorningRun(scopedDb, definition, now);
        sameDayMorningMeta =
          (morningRun?.source_metadata as Record<string, unknown> | undefined) ?? null;
      } catch {
        sameDayMorningMeta = null; // optional context — never fail the evening run on it
      }
    }

    const composed = await composeBriefing(
      scopedDb,
      definition,
      {
        runKind: input.runKind,
        runId,
        jobId: input.jobId,
        sameDayMorningMeta,
        now
      },
      input.composeDeps
    );
    // Plan step (R2.3-T06): after composition, before the run persists, all
    // inside the caller's transaction through public ports. A task creation
    // failure already threw above, so the whole run rolls back here.
    const auto = await this.planAutoBlocks(scopedDb, definition, input, runId, now, composed);
    const run = await this.persistRun(
      scopedDb,
      definition,
      input,
      runId,
      composed,
      auto?.record ?? null
    );
    return { run, created: true, auto: auto?.dispatch ?? null };
  }

  // Reads one automatic plan effect per composed signal. Returns the
  // persisted record fragment plus the dispatch identity when a batch was
  // reserved, or null when composition carried no automatic effect.
  private async planAutoBlocks(
    scopedDb: DataContextDb,
    definition: BriefingDefinition,
    input: GenerateBriefingRunInput,
    runId: string,
    now: Date,
    composed: {
      status: BriefingRunStatus;
      sourceMetadata: Record<string, unknown>;
    }
  ): Promise<{
    readonly record: { planId: string; operationId: string | null; batchKey: string | null };
    readonly dispatch: GenerateBriefingRunOutcome["auto"];
  } | null> {
    if (!input.dayPlanAuto || composed.status !== "succeeded") return null;
    // R2.3-T06B: "Use for planning" off means no automatic plan effect in any
    // mode. The check lives here so the port keeps no behaviour dependency;
    // prep tasks were already created during composition and are unaffected.
    if (!(await sourceIncludedInBriefings(scopedDb, input.composeDeps, "calendar.planning"))) {
      return null;
    }
    const signals = readAutoSignals(composed.sourceMetadata);
    if (signals.length === 0) return null;
    const timeZone = timezoneFor(definition.schedule_metadata);
    const result = await input.dayPlanAuto.reserveAutoPlan(scopedDb, {
      runId,
      definitionId: definition.id,
      localDay: localDayString(timeZone, now),
      timeZone,
      signals
    });
    if (!result) return null;
    return {
      record: {
        planId: result.planId,
        operationId: result.operationId,
        batchKey: result.batchKey
      },
      dispatch:
        result.operationId && result.batchKey
          ? { planId: result.planId, operationId: result.operationId, batchKey: result.batchKey }
          : null
    };
  }

  // Duplicate scheduled fire: reload the unfinished batch of the recorded
  // plan by its durable key and re-enqueue it. Appends no block and composes
  // nothing.
  private async resumeAutoBatch(
    scopedDb: DataContextDb,
    input: GenerateBriefingRunInput,
    existing: BriefingRun
  ): Promise<GenerateBriefingRunOutcome["auto"]> {
    if (!input.dayPlanAuto) return null;
    const recorded = readAutoRecord(existing.source_metadata);
    if (!recorded) return null;
    const resumed = await input.dayPlanAuto.findUnfinishedBatch(scopedDb, {
      planId: recorded.planId,
      batchKey: recorded.batchKey
    });
    if (!resumed) return null;
    return {
      planId: recorded.planId,
      operationId: resumed.operationId,
      batchKey: recorded.batchKey
    };
  }

  private async persistRun(
    scopedDb: DataContextDb,
    definition: BriefingDefinition,
    input: GenerateBriefingRunInput,
    runId: string,
    composed: {
      status: BriefingRunStatus;
      summaryText: string;
      sourceMetadata: Record<string, unknown>;
      structuredPayload: BriefingStructuredPayloadV1;
    },
    auto: { planId: string; operationId: string | null; batchKey: string | null } | null = null
  ): Promise<BriefingRun> {
    const createdAt = new Date();
    const run = await scopedDb.db
      .insertInto("app.briefing_runs")
      .values({
        id: runId,
        definition_id: definition.id,
        owner_user_id: definition.owner_user_id,
        status: composed.status,
        run_kind: input.runKind,
        briefing_type: definition.briefing_type,
        summary_text: composed.summaryText,
        source_metadata: {
          ...composed.sourceMetadata,
          structuredPayload: composed.structuredPayload,
          ...(auto ? { dayPlanAuto: auto } : {})
        },
        created_at: createdAt
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await scopedDb.db
      .updateTable("app.briefing_definitions")
      .set({ last_run_at: createdAt, updated_at: createdAt })
      .where("id", "=", definition.id)
      .execute();

    return run;
  }

  private async findScheduledRunForLocalPeriod(
    scopedDb: DataContextDb,
    definition: BriefingDefinition,
    now: Date
  ): Promise<BriefingRun | undefined> {
    const currentPeriod = localPeriodString(definition, now);

    const recent = await scopedDb.db
      .selectFrom("app.briefing_runs")
      .selectAll()
      .where("definition_id", "=", definition.id)
      .where("run_kind", "=", "scheduled")
      .orderBy("created_at", "desc")
      .limit(5)
      .execute();

    return recent.find((run) => {
      const created = run.created_at instanceof Date ? run.created_at : new Date(run.created_at);
      return localPeriodString(definition, created) === currentPeriod;
    });
  }

  private async findSameLocalDayMorningRun(
    scopedDb: DataContextDb,
    definition: BriefingDefinition,
    now: Date
  ): Promise<BriefingRun | undefined> {
    const currentPeriod = localPeriodString(definition, now);
    const recent = await scopedDb.db
      .selectFrom("app.briefing_runs")
      .selectAll()
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("briefing_type", "=", "morning")
      .where("status", "=", "succeeded")
      .orderBy("created_at", "desc")
      .limit(5)
      .execute();
    return recent.find((run) => {
      const created = run.created_at instanceof Date ? run.created_at : new Date(run.created_at);
      return localPeriodString(definition, created) === currentPeriod;
    });
  }

  async getOwnedDefinitionById(
    scopedDb: DataContextDb,
    definitionId: string
  ): Promise<BriefingDefinition | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.briefing_definitions")
      .selectAll()
      .where("id", "=", definitionId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
  }
}

/** Signals carrying automatic plan effects from composed metadata. */
function readAutoSignals(sourceMetadata: Record<string, unknown>): BriefingAutoSignal[] {
  const raw = sourceMetadata["calendarSignals"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (signal): signal is BriefingAutoSignal =>
      !!signal &&
      typeof signal === "object" &&
      typeof (signal as { summary?: unknown }).summary === "string" &&
      Array.isArray((signal as { suggestedActions?: unknown }).suggestedActions)
  );
}

/** The recorded automatic plan fragment of a persisted run, if any. */
function readAutoRecord(sourceMetadata: unknown): { planId: string; batchKey: string } | null {
  if (!sourceMetadata || typeof sourceMetadata !== "object" || Array.isArray(sourceMetadata)) {
    return null;
  }
  const raw = (sourceMetadata as Record<string, unknown>)["dayPlanAuto"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record["planId"] !== "string" || typeof record["batchKey"] !== "string") return null;
  return { planId: record["planId"] as string, batchKey: record["batchKey"] as string };
}

/** Daily local day (YYYY-MM-DD) for `now` in the definition's IANA tz. */
function localDayString(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  const day = parts.find((part) => part.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

/** Local period string for `now` in the definition's IANA tz. */
function localPeriodString(definition: BriefingDefinition, now: Date): string {
  const timeZone = timezoneFor(definition.schedule_metadata);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });
  const parts = formatter.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === "year")!.value, 10);
  const month = parseInt(parts.find((p) => p.type === "month")!.value, 10) - 1;
  const day = parseInt(parts.find((p) => p.type === "day")!.value, 10);

  if (definition.cadence === "weekly") {
    const localDate = new Date(year, month, day);
    const dayOfWeek = localDate.getDay();
    localDate.setDate(localDate.getDate() - dayOfWeek); // Shift to Sunday
    const weekYear = localDate.getFullYear();
    const weekMonth = String(localDate.getMonth() + 1).padStart(2, "0");
    const weekDay = String(localDate.getDate()).padStart(2, "0");
    return `${weekYear}-W${weekMonth}-${weekDay}`;
  }

  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
