import {
  gatherToolSection,
  emptySection,
  buildPersonaBlock,
  sourceIncludedInBriefings,
  readCalendarSignalSettings,
  readEmailSignalSettings,
  synthesizeWithConfiguredModel,
  sourceContextMetaFor,
  recordSourceAuthGap,
  buildExternalModulesSection,
  ctxFor,
  MORNING_MAX_OUTPUT_TOKENS,
  isOpenCommitment,
  type ComposeDeps,
  type ComposeRunInput,
  type ComposeResult,
  type Section,
  type BriefingGap
} from "./compose-shared.js";
import { collectExternalBriefingContributions } from "./external-contributions.js";
import { sanitizeExternal, renderExternalBlock, TRUST_BOUNDARY } from "./trust-boundary.js";
import type { ChatTurn } from "@moss/ai";
import { rankPriorityCandidates, type PriorityResult, type PrioritySource } from "@moss/priority";
import type { BriefingDefinition, DataContextDb } from "@moss/db";
import { composeEveningBriefing } from "./compose-evening.js";

import {
  eventCoversDay,
  localDay,
  isNewsBriefingEvidence,
  isSportsBriefingEvidence,
  type NewsBriefingEvidenceV1,
  type SportsBriefingEvidenceV1
} from "@moss/shared";
import { resolveBriefingFreshness } from "./freshness.js";
import { withToolSavepoint } from "./savepoint.js";
import { resolvePlanContext } from "./plan-context.js";
import { tidyMorningSections } from "./morning-order.js";
import { planSection } from "./plan-prose.js";
import { timezoneFor } from "./schedule.js";
import { contextTokens, deriveCalendarSignals, deriveEmailSignals } from "./signals.js";
import {
  calendarSignalsToCandidates,
  emailSignalsToCandidates,
  readPriorityModel,
  tasksToCandidates
} from "./priority-consumer.js";
import { fallback } from "./fallback.js";
import { briefingSignalFeedbackItemId } from "./feedback-targets.js";
import {
  buildEmailCatchUp,
  catchUpWindowSince,
  filterEmailItems,
  gatherActionRows,
  loadCatchUpHandledRefs
} from "./action-rows.js";
import {
  buildMorningEmailLines,
  gatherCommitmentSuggestions,
  gatherMorningTasks,
  isBriefingEmailItem,
  openTaskLines,
  settleJudgedEmail
} from "./morning-inputs.js";
import {
  CALENDAR_TODAY_SECTION_KEY,
  CALENDAR_TODAY_SECTION_LABEL,
  calendarTodaySection,
  gatherWeatherSection
} from "./morning-day.js";

// ── Caps (one conservative economy budget) ─────────────────────────────────────
const VAULT_CHUNK_CAP = 6;
const VAULT_EXCERPT_CHARS = 400;
const CATCH_UP_FALLBACK_MS = 24 * 60 * 60 * 1000; // morning catch-up window with no prior run

function orderByPriority<T>(
  items: readonly T[],
  source: PrioritySource,
  titleForItem: (item: T) => string,
  priorityResults: readonly PriorityResult[]
): T[] {
  if (priorityResults.length === 0) return [...items];
  const order = new Map<string, number>();
  for (const [index, result] of priorityResults.entries()) {
    if (result.source === source && !order.has(result.title)) {
      order.set(result.title, index);
    }
  }
  return [...items].sort(
    (a, b) =>
      (order.get(titleForItem(a)) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(titleForItem(b)) ?? Number.MAX_SAFE_INTEGER)
  );
}

export async function composeBriefing(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps
): Promise<ComposeResult> {
  if (definition.briefing_type === "evening") {
    return composeEveningBriefing(scopedDb, definition, input, deps);
  }
  const gaps: BriefingGap[] = [];
  // Use the caller's captured `now` (so the idempotency lock-day and the content window
  // agree); fall back to a fresh Date() for a direct/manual call that omits it.
  const now = input.now ?? new Date();
  // Per-user IANA tz — the SAME helper the scheduler uses, so cron fire time and the
  // local-day content window agree. No cross-user read: tz comes off this definition.
  const timeZone = timezoneFor(definition.schedule_metadata);
  const actionRows = await gatherActionRows(scopedDb, definition, input, deps, gaps);
  const plan = await resolvePlanContext(scopedDb, definition, now, deps, gaps);

  const commitments = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "commitments",
      label: "COMMITMENTS",
      toolName: "commitments.listVisible",
      arrayKey: "commitments",
      include: isOpenCommitment,
      format: (c) =>
        [
          sanitizeExternal(c.title),
          sanitizeExternal(c.status),
          sanitizeExternal(c.dueAt),
          sanitizeExternal(c.counterparty)
        ]
          .filter(Boolean)
          .join(" · ")
    },
    gaps,
    now,
    timeZone
  );

  const tasks = await gatherMorningTasks([scopedDb, definition, input, deps], gaps, now, timeZone);

  const includeCalendar = await sourceIncludedInBriefings(scopedDb, deps, "calendar.briefings");
  const rawCalendar = includeCalendar
    ? await gatherToolSection(
        scopedDb,
        definition,
        input,
        deps,
        {
          key: "calendar",
          label: "CALENDAR",
          toolName: "calendar.listVisibleEvents",
          arrayKey: "events",
          metaKeys: ["accounts", "gaps"],
          format: (e) =>
            [sanitizeExternal(e.startsAt), sanitizeExternal(e.title)].filter(Boolean).join(" · ")
        },
        gaps,
        now,
        timeZone
      )
    : emptySection("calendar", "CALENDAR");
  const includeEmail = await sourceIncludedInBriefings(scopedDb, deps, "email.briefings");
  const rawEmail = includeEmail
    ? await gatherToolSection(
        scopedDb,
        definition,
        input,
        deps,
        {
          key: "email",
          label: "EMAIL SUMMARIES + SIGNALS",
          toolName: "email.listVisibleMessages",
          arrayKey: "messages",
          metaKeys: ["accounts", "gaps"],
          // Kept mail only (#729 §7, #2763): noise/fyi/unknown never become prompt lines,
          // and the allow-list is sender · subject · actionability · summary-or-snippet.
          format: (m) =>
            isBriefingEmailItem(m)
              ? [
                  sanitizeExternal(m.sender),
                  sanitizeExternal(m.subject),
                  sanitizeExternal(m.actionability),
                  sanitizeExternal(m.summary) || sanitizeExternal(m.snippet)
                ]
                  .filter(Boolean)
                  .join(" · ")
              : ""
        },
        gaps,
        now,
        timeZone
      )
    : emptySection("email", "EMAIL SUMMARIES + SIGNALS");
  const calendarSourceContext = sourceContextMetaFor(rawCalendar);
  const emailSourceContext = sourceContextMetaFor(rawEmail);
  recordSourceAuthGap("calendar", calendarSourceContext, gaps);
  recordSourceAuthGap("email", emailSourceContext, gaps);
  const sourceContextDegraded = [
    ...calendarSourceContext.accounts,
    ...emailSourceContext.accounts
  ].some((account) => account.source === "cache");

  // Vault: semantic ∪ recency, deduped by id/source path. Best-effort.
  const vaultLines: string[] = [];
  const vaultNotes: Array<{ path: string; id: string; excerpt: string }> = [];
  if (definition.selected_tool_names.includes("vault")) {
    try {
      const query = [...commitments.lines, ...tasks.lines, ...rawCalendar.lines]
        .join(" ")
        .slice(0, 500);
      const [semantic, recent] = await withToolSavepoint(scopedDb, async () => [
        query.trim()
          ? await deps.memoryRetriever.retrieve(scopedDb, query, VAULT_CHUNK_CAP, "vault")
          : [],
        await deps.memoryRetriever.retrieveRecent(scopedDb, VAULT_CHUNK_CAP, "vault")
      ]);
      const seen = new Set<string>();
      for (const chunk of [...semantic, ...recent]) {
        const dedupeKey = chunk.id || `${chunk.sourcePath}:${chunk.lineStart}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const excerpt = sanitizeExternal(chunk.text.slice(0, VAULT_EXCERPT_CHARS));
        vaultLines.push(`${sanitizeExternal(chunk.sourcePath)} · ${excerpt}`);
        vaultNotes.push({ path: chunk.sourcePath, id: chunk.id, excerpt });
        if (vaultLines.length >= VAULT_CHUNK_CAP) break;
      }
      if (vaultLines.length === 0) {
        gaps.push({ source: "vault", reason: "empty" });
      }
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      deps.logger?.error(
        {
          event: "briefing_tool_failed",
          tool: "vault",
          error: e.name,
          message: e.message.slice(0, 200)
        },
        "briefing vault tool failed"
      );
      gaps.push({ source: "vault", reason: "tool_failed" });
    }
  }
  const vault: Section = {
    key: "vault",
    label: "VAULT",
    lines: vaultLines,
    count: vaultLines.length
  };

  const chats = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "chats",
      label: "THE DAY'S CHATS",
      toolName: "chat.listTodaysTurns",
      arrayKey: "turns",
      // Authoritative local-day bound on the turn timestamp (the tool over-includes 36h).
      localDayField: "createdAt",
      // Allow-list: role + excerpt only — never the user-authored threadTitle.
      format: (t) =>
        [sanitizeExternal(t.role), sanitizeExternal(t.excerpt)].filter(Boolean).join(": ")
    },
    gaps,
    now,
    timeZone
  );

  const context = contextTokens(
    commitments.lines,
    tasks.lines,
    chats.lines,
    vaultNotes.map((note) => note.excerpt)
  );
  const calendarSettings = await readCalendarSignalSettings(scopedDb, deps);
  const emailSettings = await readEmailSignalSettings(scopedDb, deps);
  const calendarSignals = includeCalendar
    ? deriveCalendarSignals({
        items: rawCalendar.rawItems ?? [],
        now,
        timeZone,
        context,
        settings: calendarSettings
      })
    : [];
  const proseEmailItems = includeEmail
    ? await settleJudgedEmail(
        [scopedDb, definition, input, deps],
        filterEmailItems(rawEmail.rawItems ?? [], actionRows.sourceRefs),
        now,
        timeZone
      )
    : filterEmailItems(rawEmail.rawItems ?? [], actionRows.sourceRefs);
  const emailSignals = includeEmail
    ? deriveEmailSignals({
        // Same filter as the prompt lines: noise/fyi/unknown never seed signals.
        items: proseEmailItems.filter(isBriefingEmailItem),
        now,
        context,
        settings: emailSettings
      })
    : [];
  const priorityCandidates = [
    ...tasksToCandidates(
      // Completed lines follow the open ones and never compete for priority.
      openTaskLines(tasks.lines).map((title, index) => {
        const raw = tasks.rawItems?.[index] as
          | {
              readonly dueAt?: string;
              readonly doAt?: string;
              readonly priority?: number;
              readonly effort?: "quick" | "medium" | "large";
            }
          | undefined;
        return {
          title,
          dueAt: raw?.dueAt,
          doAt: raw?.doAt,
          priority: raw?.priority,
          effort: raw?.effort
        };
      })
    ),
    ...calendarSignalsToCandidates(calendarSignals),
    ...emailSignalsToCandidates(emailSignals)
  ];
  let priorityResults: PriorityResult[] = [];
  try {
    const [priorityModel, focusReadiness] = await withToolSavepoint(scopedDb, () =>
      Promise.all([
        readPriorityModel(scopedDb, deps.priorityPreferencesRepository),
        deps.focusReadiness?.({
          actorUserId: definition.owner_user_id,
          requestId: input.jobId ? `pgboss:${input.jobId}` : `briefing:${input.runId ?? "priority"}`
        }) ?? Promise.resolve([])
      ])
    );
    priorityResults = rankPriorityCandidates({
      model: priorityModel,
      candidates: priorityCandidates,
      now: now.toISOString(),
      timeZone,
      focusReadiness
    });
  } catch (error) {
    deps.logger?.error(
      {
        event: "briefing_priority_failed",
        error: error instanceof Error ? error.name : "UnknownError",
        candidateCount: priorityCandidates.length
      },
      "briefing priority scorer failed"
    );
  }

  const prioritizedTasks: Section = {
    ...tasks,
    lines: orderByPriority(tasks.lines, "tasks", (line) => line, priorityResults)
  };
  let prioritizedCalendarSignals = orderByPriority(
    calendarSignals,
    "calendar",
    (signal) => signal.summary,
    priorityResults
  );
  const prioritizedEmailSignals = orderByPriority(
    emailSignals,
    "email",
    (signal) => signal.summary,
    priorityResults
  );

  const calendarToday = includeCalendar
    ? calendarTodaySection(rawCalendar.rawItems, now, timeZone)
    : emptySection(CALENDAR_TODAY_SECTION_KEY, CALENDAR_TODAY_SECTION_LABEL);
  // The writer sees today's events even when no warning fires, so the source is empty only
  // when neither reached the prompt.
  if (
    includeCalendar &&
    (rawCalendar.rawItems?.length ?? 0) > 0 &&
    calendarSignals.length === 0 &&
    calendarToday.lines.length === 0
  ) {
    gaps.push({ source: "calendar", reason: "empty" });
  }
  const weather = await gatherWeatherSection(definition, input, deps, timeZone, gaps);
  const commitmentSuggestions = includeEmail
    ? await gatherCommitmentSuggestions([scopedDb, definition, input, deps], gaps, now, timeZone)
    : [];
  const emailLines = buildMorningEmailLines({
    signals: prioritizedEmailSignals,
    items: proseEmailItems,
    suggestionLines: commitmentSuggestions
  });
  if (includeEmail && (rawEmail.rawItems?.length ?? 0) > 0 && emailLines.lines.length === 0) {
    gaps.push({ source: "email", reason: "filtered_out" });
  } else if (
    emailLines.truncated &&
    !gaps.some((gap) => gap.source === "email" && gap.reason === "truncated")
  ) {
    gaps.push({ source: "email", reason: "truncated" });
  }

  prioritizedCalendarSignals = await attachCalendarFollowThrough(
    scopedDb,
    definition,
    input,
    deps,
    prioritizedCalendarSignals
  );

  const calendar: Section = {
    key: rawCalendar.key,
    label: rawCalendar.label,
    lines: prioritizedCalendarSignals.map((signal) => sanitizeExternal(signal.summary)),
    count: prioritizedCalendarSignals.length,
    rawItems: rawCalendar.rawItems
  };
  // Real meetings read for today (#2745): the raw pull spans 48 hours, so the
  // row counts only the raw events landing on the report's local day, never
  // the signal notes derived from them.
  const calendarTodayCount = (rawCalendar.rawItems ?? []).filter((item) =>
    eventCoversDay(
      {
        startsAt: String(item.startsAt ?? ""),
        endsAt: typeof item.endsAt === "string" ? item.endsAt : null,
        allDay: item.allDay === true
      },
      localDay(now, timeZone),
      timeZone
    )
  ).length;
  const email: Section = {
    key: rawEmail.key,
    label: rawEmail.label,
    lines: emailLines.lines,
    count: emailLines.lines.length,
    rawItems: rawEmail.rawItems
  };
  const catchUp = includeEmail
    ? await buildEmailCatchUp(
        scopedDb,
        rawEmail.rawItems ?? [],
        actionRows.sourceRefs,
        deps.connectorSyncAt,
        catchUpWindowSince(
          input.previousMorningRunAt ?? new Date(now.getTime() - CATCH_UP_FALLBACK_MS)
        ),
        await loadCatchUpHandledRefs(scopedDb, definition.owner_user_id, deps)
      )
    : null;
  const structuredPayload = {
    ...actionRows.payload,
    catchUp,
    ...(plan.present ? { planContext: plan.planContext } : {})
  };

  const goals = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "goals",
      label: "GOALS",
      toolName: "goals.list",
      arrayKey: "goals",
      format: (g) =>
        [sanitizeExternal(g.title), sanitizeExternal(g.status)].filter(Boolean).join(" · ")
    },
    gaps,
    now,
    timeZone
  );

  // LOADER-SEAM(sports) 3: briefing section wiring + trust-boundary channel. Only the
  // sanitized `text` field crosses into the prompt; the tool's other fields never do.
  // The typed `evidence` block travels via `meta` into `sourceMetadata.editorial`.
  const sports = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "sports",
      label: "SPORTS",
      toolName: "sports.followedFactsToday",
      arrayKey: "facts",
      toolInput: { timeZone },
      metaKeys: ["evidence"],
      // Allow-list: emit only the compact fact string. No URLs, no scores-object passthrough.
      format: (row) => sanitizeExternal(row.text)
      // no localDayField — the tool already returns today-only facts
    },
    gaps,
    now,
    timeZone
  );

  // News enters composition directly after sports, pushed only when selected,
  // mirroring the sports push. Prompt lines stay fact-only; evidence rides in meta.
  const news = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "news",
      label: "NEWS",
      toolName: "news.topHeadlinesToday",
      arrayKey: "facts",
      metaKeys: ["evidence"],
      format: (row) => sanitizeExternal(row.text)
    },
    gaps,
    now,
    timeZone
  );

  const sections: Section[] = [
    commitments,
    prioritizedTasks,
    calendar,
    calendarToday,
    weather,
    email,
    vault,
    chats
  ];
  sections.push(planSection(plan.planContext, prioritizedTasks.rawItems, rawCalendar.rawItems));
  if (definition.selected_tool_names.includes("goals.list")) {
    sections.push(goals);
  }
  if (definition.selected_tool_names.includes("sports.followedFactsToday")) {
    sections.push(sports);
  }
  if (definition.selected_tool_names.includes("news.topHeadlinesToday")) {
    sections.push(news);
  }

  // #1282: external (JSON-manifest) modules cannot register an in-process assistant tool,
  // so they never reach findExecute() above — the composition root injects a worker
  // invoker instead. Absent everywhere else (unit tests, defaultComposeDeps in jobs.ts) →
  // no candidates, no call, no section (J1/J3).
  if (deps.invokeExternalBriefing) {
    const ctx = ctxFor(definition, input);
    const externalContributions = await collectExternalBriefingContributions({
      manifests: deps.externalBriefingManifests ?? [],
      selectedToolNames: definition.selected_tool_names,
      section: "morning",
      actorUserId: ctx.actorUserId,
      requestId: ctx.requestId,
      invoke: deps.invokeExternalBriefing
    });
    const externalModules = buildExternalModulesSection(externalContributions);
    if (externalModules) {
      sections.push(externalModules);
    }
  }

  // Lines each section actually gave the synthesis prompt (#2745). The reader
  // names these per source, so a row measures what fed this report, never the
  // raw holdings behind a section.
  const sectionLineCounts: Record<string, number> = {};
  for (const section of sections) sectionLineCounts[section.key] = section.lines.length;
  const editorial = captureEditorialEvidence(sports, news, deps);
  const moduleCapturedAt: Record<string, string | null> = {};
  for (const section of [sports, news] as const) {
    if (sections.some((s) => s.key === section.key)) {
      const block = (editorial as Record<string, unknown>)[section.key];
      const captured =
        section.key === "sports"
          ? (block as SportsBriefingEvidenceV1 | undefined)?.capturedAt
          : (block as NewsBriefingEvidenceV1 | undefined)?.capturedAt;
      moduleCapturedAt[section.key] = typeof captured === "string" ? captured : null;
    }
  }
  const needsModuleFreshness = "sports" in moduleCapturedAt || "news" in moduleCapturedAt;
  const hasFreshnessDeps = !!(deps.connectorSyncAt ?? deps.vaultLastWriteAt);
  const sourceTimestamps =
    hasFreshnessDeps || needsModuleFreshness
      ? await resolveBriefingFreshness(
          scopedDb,
          sections.map((s) => s.key),
          now,
          {
            connectorSyncAt: deps.connectorSyncAt,
            vaultLastWriteAt: deps.vaultLastWriteAt,
            moduleCapturedAt
          }
        )
      : undefined;

  const messages = await buildMessages(scopedDb, definition, sections, deps);
  const synth = await synthesizeWithConfiguredModel(
    scopedDb,
    deps,
    messages,
    MORNING_MAX_OUTPUT_TOKENS
  );
  if (!synth.ok) {
    return fallback(
      sections,
      gaps,
      synth.reason,
      commitments,
      prioritizedTasks,
      calendar,
      email,
      vault,
      chats,
      vaultNotes,
      structuredPayload,
      sourceTimestamps,
      editorial,
      plan.planSnapshot
    );
  }
  return {
    status: "succeeded",
    summaryText: tidyMorningSections(
      synth.text,
      (rawCalendar.rawItems ?? []).flatMap((item) =>
        typeof item["title"] === "string" ? [item["title"]] : []
      )
    ),
    sourceMetadata: {
      commitmentCount: commitments.count,
      taskCount: prioritizedTasks.count,
      goalsCount: goals.count,
      sectionLines: sectionLineCounts,
      calendarTodayCount,
      calendarCount: calendar.count,
      calendarEventCount: rawCalendar.rawItems?.length ?? 0,
      calendarSignals: prioritizedCalendarSignals,
      emailCount: email.count,
      emailMessageCount: rawEmail.rawItems?.length ?? 0,
      emailSignals: prioritizedEmailSignals,
      emailKept: emailLines.breakdown,
      // The next morning run reads completed tasks from here, so work finished while this
      // run was writing is not skipped.
      tasksReadAt: now.toISOString(),
      vaultCount: vault.count,
      chatTurnCount: chats.count,
      notes: vaultNotes,
      aiModel: {
        id: synth.model.id,
        displayName: synth.model.display_name,
        tier: synth.model.tier
      },
      gaps,
      editorial,
      ...(plan.planSnapshot !== undefined ? { planSnapshot: plan.planSnapshot } : {}),
      // Live/cache provenance per connected account (#729): degraded means at least one
      // account was served from the fallback cache after a transient live-read failure.
      sourceContext: { email: emailSourceContext, calendar: calendarSourceContext },
      degraded: sourceContextDegraded,
      ...(sourceTimestamps !== undefined ? { sourceTimestamps } : {})
    },
    structuredPayload
  };
}

async function attachCalendarFollowThrough<
  T extends {
    readonly type: string;
    readonly summary: string;
    readonly suggestedActions: readonly string[];
    readonly startsAt?: string;
    readonly endsAt?: string;
  }
>(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps,
  signals: readonly T[]
): Promise<T[]> {
  if (!deps.calendarFollowThrough) return [...signals];
  const ctx = ctxFor(definition, input);
  // One signal at a time: two signals can share a task key, and parallel create calls would
  // both miss the existence check and collide on the unique index.
  const results: T[] = [];
  for (const signal of signals) {
    if (
      !signal.suggestedActions.includes("create_task") &&
      !signal.suggestedActions.includes("block_time")
    ) {
      results.push(signal);
      continue;
    }
    const targetRef = briefingSignalFeedbackItemId("calendar", signal.type, signal.summary);
    // Task creation failures propagate: the generation transaction rolls
    // back, so a failed task can never leave a block with a guessed id.
    // Intent building itself is pure and cannot throw.
    try {
      const followThrough = await deps.calendarFollowThrough.executeAutoActions({
        scopedDb,
        actorUserId: ctx.actorUserId,
        requestId: ctx.requestId,
        targetRef,
        signal
      });
      results.push({ ...signal, followThrough });
    } catch (error) {
      deps.logger?.error(
        {
          event: "calendar_follow_through_failed",
          error: error instanceof Error ? error.name : "UnknownError",
          signalType: signal.type
        },
        "calendar follow-through failed"
      );
      throw error;
    }
  }
  return results;
}

// ── Trust boundary (prompt-injection hardening, #316) ──────────────────────────
// The trusted preamble below is a PURE LITERAL — it interpolates NO section/tool/
// retriever value, so no external content can ever enter the trusted text. Every
// gathered value is emitted inside a delimited <external_source> block by
// renderExternalBlock, never here. Channel set: commitments, tasks, calendar, calendar_today,
// weather, email, vault, chats (built in composeBriefing) + day_plan (always) + goals + sports + news
// (selection-gated) + web_research (#31, not wired yet — its tag is reserved so the channel is
// already covered the day it lands).
const SYNTHESIS_INSTRUCTIONS_MORNING =
  "You are a calm morning-briefing writer. Use this exact layout and never write a label " +
  "such as Headline, Lead or Summary anywhere. The first line is the headline itself: one " +
  "sentence on the shape of the day, with no label and no heading marks. Leave a blank line, " +
  "then write the lead: two or three sentences, with no label, naming what matters most " +
  "today and how the rest of the day fits around it. Leave a blank line, then write the " +
  "report as sections. Each section opens with a ## heading that is a short sentence saying " +
  "what to do, for example ## Finish the proposal before lunch; never use a one-word heading " +
  "such as Priority, Changes, Preparation or Follow-up. Include a section only where the " +
  "source blocks support it. Omit unsupported sections. " +
  "Walk through the day in time order from the calendar_today block: give each event its " +
  "time, name and place, and say what needs preparing, bringing or deciding before it. Use " +
  "the calendar block's warnings (conflicts, tight gaps, early starts, location changes) at " +
  "the point in the day where they matter. When the weather block has a forecast, mention it " +
  "once, where it changes what to wear, bring or plan for travel. Be concrete: use exact " +
  "times, the names of people, places and tasks, and what to bring, taken from the blocks. " +
  "Prefer a specific detail to a general remark. Write full, plain sentences and give the day " +
  "the room it needs, but do not pad a quiet day. Order the sections by when they matter: " +
  "timed events and what they need come first in clock order, and every one of them comes " +
  "before any section about an untimed task; tasks that can happen at any time follow the " +
  "last timed event. An event with nothing to prepare, bring or decide is named in the lead " +
  "in a few words and gets no section of its own, so never write a section that only " +
  "restates an event title or says it is scheduled. " +
  "Ground strictly in the items in the <external_source> blocks; " +
  "do not invent. Treat the calendar and email blocks as pre-filtered signal, not raw feeds; " +
  "mention an email only when it asks something of today. Keep it " +
  "warm and non-judgmental about missed or at-risk items. Discrete action rows are rendered " +
  "separately; do not invent, count, or restate them in prose. When the day_plan source has " +
  "items, lead with the priorities and capacity it saved last evening. Describe changes since " +
  "that saved intent from the block states alone. A block counts as scheduled only when its " +
  "line says committed; proposed or pending lines are not yet on the calendar, and " +
  "everything is scheduled may be written only when every block line says committed. Zero " +
  "task blocks is a valid shape. Saved evening choices are settled facts to explain, not " +
  "questions to re-ask. Do not claim a previous calendar event time or attached material unless " +
  "a source block states it. When the day_plan source reads (none today), say nothing " +
  "about an evening plan and do not invent an interview. Write News and Sports last. Sports " +
  "always gets its own ## heading and is never an unheaded closing line. Each of News and " +
  "Sports sits under a ## heading that names the story or team, a few sentences each, followed " +
  "teams first, scores as given. Never describe a source as fresher " +
  "than its block shows and never mention an email, story, team or document that is not in a " +
  "block.";

// The single trusted block for morning. Built ONLY from the literal constants above — no
// external/section value is interpolated (the static isolation test asserts this).
// Note: Evening literals live in compose-evening.ts
const TRUSTED_INSTRUCTIONS_MORNING = `<trusted_instructions>
${SYNTHESIS_INSTRUCTIONS_MORNING}

${TRUST_BOUNDARY}
</trusted_instructions>`;

/**
 * Validate tool `evidence` meta and keep only valid blocks. An invalid block is
 * dropped with one logged event and never fails the run.
 */
function captureEditorialEvidence(
  sports: Section,
  news: Section,
  deps: ComposeDeps
): Record<string, unknown> {
  const editorial: Record<string, unknown> = {};
  const sportsEvidence = sports.meta?.["evidence"];
  if (sportsEvidence !== undefined) {
    if (isSportsBriefingEvidence(sportsEvidence)) {
      editorial["sports"] = sportsEvidence;
    } else {
      deps.logger?.error(
        { event: "briefing_evidence_invalid", source: "sports" },
        "briefing sports evidence invalid; dropped"
      );
    }
  }
  const newsEvidence = news.meta?.["evidence"];
  if (newsEvidence !== undefined) {
    if (isNewsBriefingEvidence(newsEvidence)) {
      editorial["news"] = newsEvidence;
    } else {
      deps.logger?.error(
        { event: "briefing_evidence_invalid", source: "news" },
        "briefing news evidence invalid; dropped"
      );
    }
  }
  return editorial;
}

async function buildMessages(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  sections: readonly Section[],
  deps: ComposeDeps
): Promise<ChatTurn[]> {
  const personaBlock = await buildPersonaBlock(scopedDb, definition, deps);
  const externalBlocks = sections.map(renderExternalBlock);
  // ONE user turn (L4: no ChatTurn change): trusted preamble (pure literal) → first-party
  // persona (Q1: trusted, emitted unwrapped) → one delimited <external_source> block per
  // channel. No external value touches the trusted text; persona never wraps as external.
  return [
    {
      role: "user",
      content: [TRUSTED_INSTRUCTIONS_MORNING, personaBlock, ...externalBlocks]
        .filter(Boolean)
        .join("\n\n")
    }
  ];
}

export {
  gatherToolSection,
  emptySection,
  buildPersonaBlock,
  sourceIncludedInBriefings,
  readCalendarSignalSettings,
  readEmailSignalSettings,
  synthesizeWithConfiguredModel,
  SECTION_ITEM_CAP,
  SECTION_CHAR_CAP,
  ECONOMY_MAX_OUTPUT_TOKENS,
  MORNING_MAX_OUTPUT_TOKENS
} from "./compose-shared.js";
export type {
  GenerateChatFn,
  ComposeDeps,
  ComposeRunInput,
  ComposeResult,
  Section,
  BriefingGap,
  SynthesisFailureReason,
  CalendarAutoIntent,
  CalendarFollowThroughRefs
} from "./compose-shared.js";
export { sanitizeExternal, renderExternalBlock, TRUST_BOUNDARY } from "./trust-boundary.js";
