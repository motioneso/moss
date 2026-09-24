import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { ActiveModulesResolver, AiRepository, AiSecretCipher } from "@moss/ai";
import { HttpApiAdapter, parseAiApiKeyCredential } from "@moss/ai";
import type { ChatTurn, GenerateChatInput, ProviderKind } from "@moss/ai";
import type { FocusSignalInput } from "@moss/priority";
import type { BriefingDefinition, BriefingRunStatus, DataContextDb } from "@moss/db";
import type { CalendarSignalSettings, EmailSignalSettings } from "./signals.js";
import type { MemoryRetriever } from "@moss/memory";
import type { MossModuleManifest, JsonMossModuleManifest } from "@moss/module-sdk";
import { isBehaviorEnabled, type SourceBehaviorPolicyDeps } from "@moss/source-behaviors";
import {
  parseCalendarAutomationMode,
  normalizePersonaSettings,
  renderPersonaText,
  type DayPlanDto
} from "@moss/shared";
import type { BriefingContribution, ExternalBriefingInvoker } from "./external-contributions.js";
import { withToolSavepoint } from "./savepoint.js";
import type { BriefingStructuredPayloadV1 } from "@moss/shared";

export type GenerateChatFn = (input: GenerateChatInput) => Promise<{ readonly text: string }>;

export const SECTION_ITEM_CAP = 8;
export const SECTION_CHAR_CAP = 1200;
export const ECONOMY_MAX_OUTPUT_TOKENS = 1024;
export interface ComposeDeps {
  readonly moduleManifests: readonly MossModuleManifest[];
  readonly aiRepository: AiRepository;
  readonly cipher: AiSecretCipher;
  readonly memoryRetriever: MemoryRetriever;
  readonly personaRepository?: {
    get(scopedDb: DataContextDb, key: string): Promise<unknown>;
  };
  readonly priorityPreferencesRepository?: {
    get(scopedDb: DataContextDb, key: string): Promise<unknown>;
  };
  readonly focusReadiness?: (ctx: {
    readonly actorUserId: string;
    readonly requestId: string;
  }) => Promise<readonly FocusSignalInput[]>;
  readonly sourceBehaviorPolicy?: SourceBehaviorPolicyDeps;
  readonly resolveUserName?: (scopedDb: DataContextDb, actorUserId: string) => Promise<string>;
  /**
   * Structured logger for tool-failure observability (briefing_tool_failed events).
   * Optional for back-compat; production injects a module logger (observability spec).
   */
  readonly logger?: Pick<FastifyBaseLogger, "error">;
  readonly connectorSyncAt?: (
    scopedDb: DataContextDb,
    kind: "email" | "calendar"
  ) => Promise<Date | null>;
  readonly vaultLastWriteAt?: (scopedDb: DataContextDb) => Promise<Date | null>;
  /** Injected by the composition root; gates email/calendar cached reads to accounts with active grants. */
  /** Injected by the composition root; skips tools whose module is inactive for the actor. */
  readonly resolveActiveModules?: ActiveModulesResolver;
  readonly featureGrantService?: {
    grantedAccountIds(
      scopedDb: DataContextDb,
      feature: "email" | "calendar"
    ): Promise<ReadonlySet<string>>;
  };
  /**
   * Injected by the composition root; live-first email/calendar reads for the read tools (#729).
   * Structural — briefings never imports connectors (module isolation).
   */
  readonly sourceContextService?: {
    listEmailContext(scopedDb: DataContextDb, input: Record<string, unknown>): Promise<unknown>;
    listCalendarContext(scopedDb: DataContextDb, input: Record<string, unknown>): Promise<unknown>;
  };
  /**
   * Injected by the composition root; reads the actor's saved day plan for the
   * run's local day (T12). Structural — briefings never imports calendar; the
   * calendar repository satisfies this shape.
   */
  readonly dayPlanRead?: {
    getForDay(
      scopedDb: DataContextDb,
      input: { readonly localDay: string; readonly timeZone: string }
    ): Promise<DayPlanDto | undefined>;
  };
  readonly calendarFollowThrough?: {
    executeAutoActions(args: {
      readonly scopedDb: DataContextDb;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly targetRef: string;
      readonly signal: {
        readonly summary: string;
        readonly suggestedActions: readonly string[];
        readonly startsAt?: string;
        readonly endsAt?: string;
      };
    }): Promise<CalendarFollowThroughRefs>;
  };
  /** Injectable for tests; defaults to constructing a real HttpApiAdapter. */
  readonly createAdapter?: (
    kind: ProviderKind,
    apiKey: string,
    baseUrl: string | null
  ) => { generateChat: GenerateChatFn };
  /**
   * External modules ship JSON manifests with no in-process `execute`, so the composer
   * cannot resolve them through findExecute(). The composition root injects a worker
   * invoker instead. Absent in tests and in defaultComposeDeps → no external sections (#1282).
   */
  readonly invokeExternalBriefing?: ExternalBriefingInvoker;
  /** External manifests, injected separately — NOT read off `moduleManifests` (J1): that
   *  array's only production supplier is getBuiltInModuleManifests(), which never contains
   *  an external (JSON-manifest) module. */
  readonly externalBriefingManifests?: readonly JsonMossModuleManifest[];
}

// Typed automatic effect for one briefing signal (R2.3-T06). Composition emits
// intents only: task creation still resolves through the Tasks port in the
// generation transaction, but no provider call and no day-plan write happens
// here. The generation plan step turns block_time intents into plan blocks.
export interface CalendarAutoIntent {
  readonly kind: "create_task" | "block_time";
  readonly targetRef: string;
  readonly title: string;
  readonly window?: {
    readonly start: string;
    readonly end: string;
    readonly durationMinutes: number;
  };
}

export interface CalendarFollowThroughRefs {
  readonly targetRef: string;
  readonly taskId?: string;
  readonly intents: readonly CalendarAutoIntent[];
}

export interface ComposeRunInput {
  readonly runKind: "manual" | "scheduled";
  readonly runId?: string;
  readonly jobId?: string;
  /** Single captured "now" from the caller so lock-day, idempotency, and the local-day
   *  content window all agree across a midnight boundary. Defaults to a fresh Date(). */
  readonly now?: Date;
  /**
   * Evening runs only: the same-local-day morning run's source_metadata, resolved by the
   * repository (compose cannot import repository — circular). Optional and degradable:
   * absent/null emits no morning_plan block and no gap.
   */
  readonly sameDayMorningMeta?: Record<string, unknown> | null;
}

export interface BriefingGap {
  readonly source: string;
  // No `empty_cache`: we cannot distinguish synced-empty from not-synced-yet until the
  // connector-sync slice lands cache state, so an empty source is just `empty`.
  // `source_auth` (#729): a live-first source-context read reported an auth/grant/revocation
  // gap — the user must reconnect or re-grant; the data was NOT silently served from cache.
  readonly reason:
    | "tool_failed"
    | "structured_payload_failed"
    | "truncated"
    | "empty"
    | "unwired"
    | "source_auth"
    | "module_disabled";
}

export interface ComposeResult {
  readonly status: BriefingRunStatus;
  readonly summaryText: string;
  readonly sourceMetadata: Record<string, unknown>;
  readonly structuredPayload: BriefingStructuredPayloadV1;
}

export interface Section {
  readonly key: string;
  readonly label: string;
  readonly lines: readonly string[];
  readonly count: number;
  readonly rawItems?: readonly Record<string, unknown>[];
  /** Named top-level tool-response keys captured via `metaKeys` (e.g. source-context accounts/gaps). */
  readonly meta?: Record<string, unknown>;
}

export function ctxFor(definition: BriefingDefinition, input: ComposeRunInput) {
  return {
    actorUserId: definition.owner_user_id,
    requestId: input.jobId ? `pgboss:${input.jobId}` : `briefing:${input.runId ?? randomUUID()}`,
    chatSessionId: ""
  };
}

/**
 * Folds already-sanitized external-module contributions (#1282) into one fixed, enumerable
 * channel (`external_modules`) rather than one block per installed module id — TRUST_BOUNDARY
 * names its channels as a static literal, and a dynamic per-module channel name could never be
 * listed there ahead of time. Shared by compose.ts and compose-evening.ts so the two briefing
 * kinds render external contributions identically. `undefined` when there is nothing to say,
 * matching every other conditionally-pushed section (goals, sports) rather than emitting an
 * always-present empty block.
 */
export function buildExternalModulesSection(
  contributions: readonly BriefingContribution[]
): Section | undefined {
  if (contributions.length === 0) return undefined;
  return {
    key: "external_modules",
    label: "EXTERNAL MODULES",
    lines: contributions.flatMap((contribution) =>
      contribution.items.length > 0
        ? contribution.items.map((item) =>
            [contribution.headline, item.title, item.detail, item.href ? `(${item.href})` : ""]
              .filter(Boolean)
              .join(" · ")
          )
        : [contribution.headline]
    ),
    count: contributions.reduce((total, contribution) => total + contribution.items.length, 0)
  };
}

/**
 * Authoritative per-user local-day check for a field we are EXPLICITLY day-bounding.
 * `timeZone` is the definition's IANA tz (from `timezoneFor(...)`). An item whose
 * timestamp falls on a different local calendar day than `now` is excluded. FAILS
 * CLOSED: a missing/unparseable timestamp on a day-bound field cannot be confirmed to
 * be "today", so it is EXCLUDED (a stale row with no usable date must not leak into a
 * today-bounded section).
 */
export function withinLocalDay(isoOrDate: unknown, now: Date, timeZone: string): boolean {
  if (typeof isoOrDate !== "string" || isoOrDate.trim() === "") {
    return false;
  }
  const ts = new Date(isoOrDate);
  if (Number.isNaN(ts.getTime())) {
    return false;
  }
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
  return fmt(ts) === fmt(now);
}

export function findExecute(manifests: readonly MossModuleManifest[], toolName: string) {
  return manifests.flatMap((m) => m.assistantTools ?? []).find((t) => t.name === toolName);
}

export function capLines(lines: string[]): { lines: string[]; truncated: boolean } {
  const itemCapped = lines.slice(0, SECTION_ITEM_CAP);
  let total = 0;
  const out: string[] = [];
  let truncated = lines.length > SECTION_ITEM_CAP;
  for (const line of itemCapped) {
    if (total + line.length > SECTION_CHAR_CAP) {
      truncated = true;
      break;
    }
    out.push(line);
    total += line.length;
  }
  return { lines: out, truncated };
}

export function emptySection(key: string, label: string): Section {
  return { key, label, lines: [], count: 0 };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sourceIncludedInBriefings(
  scopedDb: DataContextDb,
  deps: ComposeDeps,
  behaviorId: string
): Promise<boolean> {
  if (!deps.sourceBehaviorPolicy) {
    return true;
  }
  return isBehaviorEnabled(scopedDb, deps.sourceBehaviorPolicy, behaviorId);
}

export async function readPreference(
  scopedDb: DataContextDb,
  deps: ComposeDeps,
  key: string
): Promise<unknown> {
  return deps.sourceBehaviorPolicy?.preferencesRepository.get(scopedDb, key) ?? null;
}

export function boolPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function intPreference(value: unknown, fallback: 0 | 1 | 2): 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2 ? value : fallback;
}

export async function readCalendarSignalSettings(
  scopedDb: DataContextDb,
  deps: ComposeDeps
): Promise<CalendarSignalSettings> {
  const [
    lookaheadDays,
    suggestTasks,
    createTasks,
    suggestTimeBlocks,
    blockTime,
    storedPrepTaskMode,
    storedTimeBlockMode
  ] = await Promise.all([
    readPreference(scopedDb, deps, "calendar.briefing_lookahead_days"),
    readPreference(scopedDb, deps, "calendar.signal_suggest_tasks"),
    readPreference(scopedDb, deps, "calendar.signal_create_tasks"),
    readPreference(scopedDb, deps, "calendar.signal_suggest_time_blocks"),
    readPreference(scopedDb, deps, "calendar.signal_block_time"),
    readPreference(scopedDb, deps, "calendar.prep_task_mode"),
    readPreference(scopedDb, deps, "calendar.time_block_mode")
  ]);
  const legacyPrepTaskMode =
    createTasks === true ? "auto" : suggestTasks === false ? "off" : "suggest";
  const legacyTimeBlockMode =
    blockTime === true ? "auto" : suggestTimeBlocks === false ? "off" : "suggest";
  return {
    lookaheadDays: intPreference(lookaheadDays, 2),
    prepTaskMode: parseCalendarAutomationMode(storedPrepTaskMode, legacyPrepTaskMode),
    timeBlockMode: parseCalendarAutomationMode(storedTimeBlockMode, legacyTimeBlockMode)
  };
}

export async function readEmailSignalSettings(
  scopedDb: DataContextDb,
  deps: ComposeDeps
): Promise<EmailSignalSettings> {
  const [createTasks, suggestReplies, draftReplies, autoSend] = await Promise.all([
    readPreference(scopedDb, deps, "email.signal_create_tasks"),
    readPreference(scopedDb, deps, "email.signal_suggest_replies"),
    readPreference(scopedDb, deps, "email.signal_draft_replies"),
    readPreference(scopedDb, deps, "email.signal_auto_send")
  ]);
  return {
    createTasks: boolPreference(createTasks, true),
    suggestReplies: boolPreference(suggestReplies, true),
    draftReplies: boolPreference(draftReplies, true),
    autoSend: boolPreference(autoSend, false)
  };
}

/** Gather one tool-backed section; never throws — failures become gaps. */
export async function gatherToolSection(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps,
  args: {
    readonly key: string;
    readonly label: string;
    readonly toolName: string;
    /** Explicit key in the tool's `data` that holds the row array (verified per manifest). */
    readonly arrayKey: string;
    readonly toolInput?: Record<string, unknown>;
    /**
     * Explicit per-source field allow-list. Only the fields named here cross the trust
     * boundary into the AI prompt — the projection is never inferred from the DTO shape,
     * so adding a field to a tool's DTO can never silently leak private content (e.g.
     * email bodyExcerpt, chat thread titles, or LLM-derived summary/signals).
     */
    readonly format: (item: Record<string, unknown>) => string;
    /** Optional post-read filter for prose sections (e.g. exclude suggested tasks). */
    readonly include?: (item: Record<string, unknown>) => boolean;
    /** When set, items are filtered to the definition's local day on this field. */
    readonly localDayField?: string;
    /**
     * Named top-level keys copied verbatim from the tool's `data` onto `Section.meta`
     * (#729: `accounts`/`gaps` from the source-context tools). Metadata only — meta never
     * enters prompt lines.
     */
    readonly metaKeys?: readonly string[];
  },
  gaps: BriefingGap[],
  now: Date,
  timeZone: string
): Promise<Section> {
  if (!definition.selected_tool_names.includes(args.toolName)) {
    return { key: args.key, label: args.label, lines: [], count: 0, rawItems: [] };
  }

  // A tool selected by preference but disabled for this actor stays silent: no
  // section, no execute, one module_disabled gap. The stored list is untouched,
  // so re-enabling the module needs no settings change. Absent resolver (unit
  // tests, default worker deps) keeps today's behavior.
  if (deps.resolveActiveModules) {
    const owning = deps.moduleManifests.find((manifest) =>
      (manifest.assistantTools ?? []).some((tool) => tool.name === args.toolName)
    );
    if (owning) {
      const active = await deps.resolveActiveModules(ctxFor(definition, input).actorUserId);
      if (!active.some((manifest) => manifest.id === owning.id)) {
        gaps.push({ source: args.key, reason: "module_disabled" });
        return { key: args.key, label: args.label, lines: [], count: 0, rawItems: [] };
      }
    }
  }

  const tool = findExecute(deps.moduleManifests, args.toolName);
  if (!tool?.execute) {
    gaps.push({ source: args.key, reason: "tool_failed" });
    return { key: args.key, label: args.label, lines: [], count: 0 };
  }
  try {
    const toolServices = {
      ...(deps.featureGrantService ? { featureGrants: deps.featureGrantService } : {}),
      ...(deps.sourceContextService ? { sourceContext: deps.sourceContextService } : {})
    };
    const execute = tool.execute;
    const result = await withToolSavepoint(scopedDb, () =>
      execute(scopedDb, args.toolInput ?? {}, ctxFor(definition, input), toolServices)
    );
    const data = isRecord(result.data) ? result.data : {};
    const meta: Record<string, unknown> = {};
    for (const metaKey of args.metaKeys ?? []) {
      if (metaKey in data) meta[metaKey] = data[metaKey];
    }
    const withMeta = args.metaKeys ? { meta } : {};
    const raw = data[args.arrayKey];
    let items = Array.isArray(raw) ? raw.filter(isRecord) : [];
    // Authoritative per-user local-day bound (tools return all visible rows; sync
    // slice not built yet so there is no source-side date filter — compose enforces it).
    if (args.localDayField) {
      items = items.filter((it) => withinLocalDay(it[args.localDayField!], now, timeZone));
    }
    if (args.include) {
      items = items.filter(args.include);
    }
    if (items.length === 0) {
      // Neutral `empty` only: we cannot distinguish "synced and empty" from
      // "not synced yet" until the connector-sync slice lands cache state. Do NOT
      // claim `empty_cache` — that would over-state knowledge we don't have.
      gaps.push({ source: args.key, reason: "empty" });
      return { key: args.key, label: args.label, lines: [], count: 0, rawItems: [], ...withMeta };
    }
    const allLines = items.map(args.format).filter((line) => line.length > 0);
    const { lines, truncated } = capLines(allLines);
    if (truncated) {
      gaps.push({ source: args.key, reason: "truncated" });
    }
    return {
      key: args.key,
      label: args.label,
      lines,
      count: items.length,
      rawItems: items,
      ...withMeta
    };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    deps.logger?.error(
      {
        event: "briefing_tool_failed",
        tool: args.toolName,
        error: e.name,
        message: e.message.slice(0, 200)
      },
      "briefing tool failed"
    );
    gaps.push({ source: args.key, reason: "tool_failed" });
    return { key: args.key, label: args.label, lines: [], count: 0, rawItems: [] };
  }
}

// ── Live-first source-context triage projection (#729) ─────────────────────────

const ALWAYS_ACTIONABLE_TRIAGE = new Set(["needs_reply", "needs_action", "time_sensitive_info"]);

/**
 * Prompt-line filter for triaged email items (spec #729 §7): noise/fyi/unknown never reach
 * the synthesis prompt; waiting_on_someone only when it is clearly important (high importance
 * or confident classification). Items without an actionability field are excluded — the
 * source-context tool always attaches one, so its absence means non-triaged data.
 */
export function isActionableTriage(item: Record<string, unknown>): boolean {
  const actionability = item.actionability;
  if (typeof actionability !== "string") return false;
  if (ALWAYS_ACTIONABLE_TRIAGE.has(actionability)) return true;
  if (actionability === "waiting_on_someone") {
    return (
      item.importance === "high" || (typeof item.confidence === "number" && item.confidence >= 0.7)
    );
  }
  return false;
}

export interface SourceContextSectionMeta {
  readonly accounts: ReadonlyArray<{
    readonly connectorAccountId: string;
    readonly source: "live" | "cache";
    readonly degradedReason: string | null;
  }>;
  readonly gaps: ReadonlyArray<{
    readonly connectorAccountId: string | null;
    readonly reason: string;
  }>;
}

/**
 * Project a source-context tool response's accounts/gaps (captured via `metaKeys`) into the
 * compact shape persisted on briefing source_metadata. Explicit field pick — never the raw
 * account objects, so provider metadata additions can never silently reach stored run rows.
 */
export function sourceContextMetaFor(section: Section): SourceContextSectionMeta {
  const accountsRaw = section.meta?.accounts;
  const accounts = (Array.isArray(accountsRaw) ? accountsRaw.filter(isRecord) : []).map((entry) => {
    const account = isRecord(entry.account) ? entry.account : {};
    return {
      connectorAccountId:
        typeof account.connectorAccountId === "string" ? account.connectorAccountId : "unknown",
      source: entry.source === "live" ? ("live" as const) : ("cache" as const),
      degradedReason: typeof entry.degradedReason === "string" ? entry.degradedReason : null
    };
  });
  const gapsRaw = section.meta?.gaps;
  const gaps = (Array.isArray(gapsRaw) ? gapsRaw.filter(isRecord) : []).map((gap) => ({
    connectorAccountId:
      isRecord(gap.account) && typeof gap.account.connectorAccountId === "string"
        ? gap.account.connectorAccountId
        : null,
    reason: typeof gap.reason === "string" ? gap.reason : "unknown"
  }));
  return { accounts, gaps };
}

/** Source-context gap reasons that need user action (reconnect / re-grant), not a retry. */
const SOURCE_AUTH_GAP_REASONS = new Set([
  "auth_error",
  "connector_revoked",
  "feature_grant_disabled"
]);

/** Record a `source_auth` briefing gap when a source-context read hit an auth/grant problem. */
export function recordSourceAuthGap(
  sectionKey: string,
  contextMeta: SourceContextSectionMeta,
  gaps: BriefingGap[]
): void {
  if (contextMeta.gaps.some((gap) => SOURCE_AUTH_GAP_REASONS.has(gap.reason))) {
    gaps.push({ source: sectionKey, reason: "source_auth" });
  }
}

export function defaultCreateAdapter(kind: ProviderKind, apiKey: string, baseUrl: string | null) {
  return new HttpApiAdapter(kind, apiKey, baseUrl ? { baseUrl } : {});
}

export async function buildPersonaBlock(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  deps: ComposeDeps
): Promise<string> {
  if (!deps.personaRepository || !deps.resolveUserName) {
    return "";
  }
  const [stored, userName] = await Promise.all([
    deps.personaRepository.get(scopedDb, "persona.bundle"),
    deps.resolveUserName(scopedDb, definition.owner_user_id)
  ]);
  const persona = normalizePersonaSettings(stored);
  return renderPersonaText({
    assistantName: persona.assistantName,
    personaText: persona.personaText,
    userName
  });
}

export type SynthesisFailureReason = "no_model" | "credential_error" | "synthesis_failed";

/**
 * Provider-agnostic synthesis: select the user's economy summarization model, decrypt the
 * provider credential IN WORKER SCOPE ONLY, and run one generateChat call. Never log raw
 * errors from the credential block — they can carry the decrypted key.
 */
export async function synthesizeWithConfiguredModel(
  scopedDb: DataContextDb,
  deps: ComposeDeps,
  messages: ChatTurn[]
): Promise<
  | { ok: true; text: string; model: { id: string; display_name: string; tier: string } }
  | { ok: false; reason: SynthesisFailureReason }
> {
  const model = await deps.aiRepository.selectModelForCapability(
    scopedDb,
    "summarization",
    "economy"
  );
  if (!model) {
    return { ok: false, reason: "no_model" };
  }
  let apiKey: string;
  let baseUrl: string | null;
  try {
    const provider = await deps.aiRepository.selectProviderWithCredential(
      scopedDb,
      model.provider_config_id
    );
    if (!provider?.encrypted_credential) {
      return { ok: false, reason: "credential_error" };
    }
    const credential = parseAiApiKeyCredential(
      deps.cipher.decryptJson(provider.encrypted_credential)
    );
    if (!credential) {
      return { ok: false, reason: "credential_error" };
    }
    apiKey = credential.apiKey;
    baseUrl = provider.base_url;
  } catch {
    // Never log the raw error — it can carry the decrypted key.
    return { ok: false, reason: "credential_error" };
  }
  try {
    const adapter = (deps.createAdapter ?? defaultCreateAdapter)(
      model.provider_kind as ProviderKind,
      apiKey,
      baseUrl
    );
    const { text } = await adapter.generateChat({
      model: { provider_kind: model.provider_kind, provider_model_id: model.provider_model_id },
      messages,
      maxOutputTokens: ECONOMY_MAX_OUTPUT_TOKENS
    });
    return {
      ok: true,
      text,
      model: { id: model.id, display_name: model.display_name, tier: model.tier }
    };
  } catch {
    return { ok: false, reason: "synthesis_failed" };
  }
}
