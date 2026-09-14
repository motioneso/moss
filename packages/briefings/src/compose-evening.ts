import type { ChatTurn } from "@moss/ai";
import type { BriefingDefinition, DataContextDb } from "@moss/db";
import {
  EVENING_FALLBACK_QUESTIONS,
  EVENING_SECTION_HEADERS,
  type BriefingStructuredPayloadV1
} from "@moss/shared";

import {
  emptySection,
  buildPersonaBlock,
  buildExternalModulesSection,
  ctxFor,
  gatherToolSection,
  isActionableTriage,
  readEmailSignalSettings,
  recordSourceAuthGap,
  sourceContextMetaFor,
  sourceIncludedInBriefings,
  synthesizeWithConfiguredModel,
  SECTION_CHAR_CAP,
  SECTION_ITEM_CAP,
  type BriefingGap,
  type ComposeDeps,
  type ComposeResult,
  type ComposeRunInput,
  type Section,
  type SynthesisFailureReason
} from "./compose-shared.js";
import { collectExternalBriefingContributions } from "./external-contributions.js";
import { filterEveningCalendar, partitionEveningTasks } from "./evening-lenses.js";
import { resolveBriefingFreshness } from "./freshness.js";
import { resolvePlanContext } from "./plan-context.js";
import { planSection } from "./plan-prose.js";
import { timezoneFor } from "./schedule.js";
import { contextTokens, deriveEmailSignals } from "./signals.js";
import { renderExternalBlock, sanitizeExternal, TRUST_BOUNDARY } from "./trust-boundary.js";
import { buildEmailCatchUp, filterEmailItems, gatherActionRows } from "./action-rows.js";

// ── Evening trusted literals (#316: PURE LITERALS — no external value ever) ────
// The six section headers are embedded VERBATIM from EVENING_SECTION_HEADERS
// (packages/shared/src/briefings-format.ts); the drift guard in
// tests/unit/briefings-evening-format.test.ts fails the build if they diverge.
const SYNTHESIS_INSTRUCTIONS_EVENING =
  "You are the user's calm, sharp evening chief of staff delivering the end-of-day report. " +
  "Write 200-350 words with a light narrative thread, not a data dump. Open with a one-to-two " +
  "sentence verdict on the day, with no header. Then use exactly these section headers, in this " +
  'order: "What got done", "What slipped", "Carrying forward", "Needs your attention", ' +
  '"Tomorrow", "News & sports". Ground strictly in the items inside the <external_source> ' +
  "blocks; do not invent. The tasks_reconciliation block tags each line with its lens " +
  "([completed today], [slipped], [carrying forward]) — respect those tags. " +
  '"What got done": celebrate completed work, briefly and specifically. "What slipped": name ' +
  'it plainly and without judgment. "Carrying forward": open items rolling to future days. ' +
  '"Needs your attention": commitments and email signals that need a decision or a reply. ' +
  '"Tomorrow": ALWAYS include this section — preview tomorrow\'s calendar and the likely ' +
  'focus; if it is empty, say tomorrow looks clear. "News & sports": recap from the sports ' +
  "block; if there is nothing, call it a quiet day. Treat the chats and morning_plan blocks " +
  "as context only — use them to judge what mattered today and what the morning plan expected; " +
  "never summarize them as their own topics. Where a section has no items, keep it to one " +
  "short line. Discrete action rows are rendered separately; do not invent, count, or restate " +
  "them in prose. Use the day_plan source for open commitments and the actor's own " +
  "corrections. A meeting that took place is not evidence that a follow-up was sent or that " +
  "a task finished; completion comes only from the [completed today] tags in " +
  "tasks_reconciliation, never from plan or calendar words. Close with exactly two short " +
  "reflection questions specific to today's items.";

// The single evening trusted block. Built ONLY from the two literal constants — no
// external/section value is interpolated (the static isolation test asserts this).
const TRUSTED_INSTRUCTIONS_EVENING = `<trusted_instructions>
${SYNTHESIS_INSTRUCTIONS_EVENING}

${TRUST_BOUNDARY}
</trusted_instructions>`;

export { SYNTHESIS_INSTRUCTIONS_EVENING, TRUSTED_INSTRUCTIONS_EVENING };

const LENS_ITEM_CAP = 5; // per lens → ≤15 reconciliation lines before the char cap
const COMPLETED_LOOKBACK_MS = 48 * 3_600_000; // over-fetch; withinLocalDay is authoritative
const TASKS_RECONCILIATION_LABEL = "TASKS — DAY RECONCILIATION";
const MORNING_PLAN_ITEM_CAP = 6;

/**
 * Context-only cross-reference to the same-day morning run. Reads ONLY the derived
 * signal `summary` strings from the morning metadata (never cached bodies) and
 * re-sanitizes them — they cross the trust boundary again here.
 */
function morningPlanSection(meta: Record<string, unknown> | null | undefined): Section | null {
  if (!meta) return null;
  const lines: string[] = [];
  for (const key of ["calendarSignals", "emailSignals"] as const) {
    const arr = meta[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (lines.length >= MORNING_PLAN_ITEM_CAP) break;
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { summary?: unknown }).summary === "string"
      ) {
        const line = sanitizeExternal((entry as { summary: string }).summary);
        if (line) lines.push(line);
      }
    }
  }
  if (lines.length === 0) return null;
  return { key: "morning_plan", label: "THIS MORNING'S PLAN", lines, count: lines.length };
}

function charCap(lines: readonly string[]): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > SECTION_CHAR_CAP) {
      return { lines: out, truncated: true };
    }
    out.push(line);
    total += line.length;
  }
  return { lines: out, truncated: false };
}

export async function composeEveningBriefing(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps
): Promise<ComposeResult> {
  const gaps: BriefingGap[] = [];
  const now = input.now ?? new Date();
  const timeZone = timezoneFor(definition.schedule_metadata);
  const actionRows = await gatherActionRows(scopedDb, definition, input, deps, gaps);
  const plan = await resolvePlanContext(scopedDb, definition, now, deps, gaps);

  // ── tasks_reconciliation: three lenses over two tasks.list reads ─────────────
  // Scratch gap arrays: two gathers share one section key, so per-gather empty/
  // truncated signals are recomputed after the lens partition instead.
  const doneScratch: BriefingGap[] = [];
  const doneGather = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "tasks_reconciliation",
      label: TASKS_RECONCILIATION_LABEL,
      toolName: "tasks.list",
      arrayKey: "items",
      toolInput: {
        status: "done",
        completedAfter: new Date(now.getTime() - COMPLETED_LOOKBACK_MS).toISOString()
      },
      // Authoritative user-tz "today" bound on completion time (lookback over-fetches).
      localDayField: "completedAt",
      format: (t) => sanitizeExternal(t.title)
    },
    doneScratch,
    now,
    timeZone
  );
  const openScratch: BriefingGap[] = [];
  const openGather = await gatherToolSection(
    scopedDb,
    definition,
    input,
    deps,
    {
      key: "tasks_reconciliation",
      label: TASKS_RECONCILIATION_LABEL,
      toolName: "tasks.list",
      arrayKey: "items",
      toolInput: { status: "todo" },
      format: (t) => sanitizeExternal(t.title)
    },
    openScratch,
    now,
    timeZone
  );
  const lenses = partitionEveningTasks({
    completedItems: doneGather.rawItems ?? [],
    openItems: openGather.rawItems ?? [],
    now,
    timeZone
  });
  const lensLine = (t: { title: string }) => sanitizeExternal(t.title);
  const taggedLines = [
    ...lenses.completedToday.slice(0, LENS_ITEM_CAP).map((t) => `[completed today] ${lensLine(t)}`),
    ...lenses.slipped.slice(0, LENS_ITEM_CAP).map((t) => `[slipped] ${lensLine(t)}`),
    ...lenses.carryingForward
      .slice(0, LENS_ITEM_CAP)
      .map((t) => `[carrying forward] ${lensLine(t)}`)
  ];
  const recon = charCap(taggedLines);
  if ([...doneScratch, ...openScratch].some((g) => g.reason === "tool_failed")) {
    gaps.push({ source: "tasks_reconciliation", reason: "tool_failed" });
  } else if (taggedLines.length === 0) {
    gaps.push({ source: "tasks_reconciliation", reason: "empty" });
  }
  if (
    recon.truncated ||
    lenses.completedToday.length > LENS_ITEM_CAP ||
    lenses.slipped.length > LENS_ITEM_CAP ||
    lenses.carryingForward.length > LENS_ITEM_CAP
  ) {
    gaps.push({ source: "tasks_reconciliation", reason: "truncated" });
  }
  const tasksReconciliation: Section = {
    key: "tasks_reconciliation",
    label: TASKS_RECONCILIATION_LABEL,
    lines: recon.lines,
    count: lenses.completedToday.length + lenses.slipped.length + lenses.carryingForward.length
  };

  // ── commitments: identical to the morning gather ──────────────────────────────
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

  // ── calendar_tomorrow: raw events → tomorrow + rest-of-this-evening ──────────
  const includeCalendar = await sourceIncludedInBriefings(scopedDb, deps, "calendar.briefings");
  const calScratch: BriefingGap[] = [];
  const rawCalendar = includeCalendar
    ? await gatherToolSection(
        scopedDb,
        definition,
        input,
        deps,
        {
          key: "calendar_tomorrow",
          label: "TOMORROW'S CALENDAR",
          toolName: "calendar.listVisibleEvents",
          arrayKey: "events",
          metaKeys: ["accounts", "gaps"],
          format: (e) =>
            [sanitizeExternal(e.startsAt), sanitizeExternal(e.title)].filter(Boolean).join(" · ")
        },
        calScratch,
        now,
        timeZone
      )
    : emptySection("calendar_tomorrow", "TOMORROW'S CALENDAR");
  gaps.push(...calScratch.filter((g) => g.reason === "tool_failed"));
  const tomorrowItems = filterEveningCalendar(rawCalendar.rawItems ?? [], now, timeZone);
  const tomorrowCapped = charCap(
    tomorrowItems
      .slice(0, SECTION_ITEM_CAP)
      .map((e) =>
        [sanitizeExternal(e.startsAt), sanitizeExternal(e.title)].filter(Boolean).join(" · ")
      )
  );
  if (tomorrowItems.length > SECTION_ITEM_CAP || tomorrowCapped.truncated) {
    gaps.push({ source: "calendar_tomorrow", reason: "truncated" });
  }
  const calendarSelected = definition.selected_tool_names.includes("calendar.listVisibleEvents");
  if (includeCalendar && calendarSelected && tomorrowCapped.lines.length === 0) {
    gaps.push({ source: "calendar_tomorrow", reason: "empty" });
  }
  const calendarTomorrow: Section = {
    key: "calendar_tomorrow",
    label: "TOMORROW'S CALENDAR",
    lines: tomorrowCapped.lines,
    count: tomorrowItems.length
  };

  // ── email_today: arrived today (user tz) → signal derivation ─────────────────
  const includeEmail = await sourceIncludedInBriefings(scopedDb, deps, "email.briefings");
  const emailScratch: BriefingGap[] = [];
  const rawEmail = includeEmail
    ? await gatherToolSection(
        scopedDb,
        definition,
        input,
        deps,
        {
          key: "email_today",
          label: "EMAIL ARRIVED TODAY",
          toolName: "email.listVisibleMessages",
          arrayKey: "messages",
          metaKeys: ["accounts", "gaps"],
          // Authoritative user-tz "arrived today" bound.
          localDayField: "receivedAt",
          // Actionable triage only (#729 §7): noise/fyi/unknown never become prompt lines,
          // and the allow-list is sender · subject · actionability · summary-or-snippet.
          format: (m) =>
            isActionableTriage(m)
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
        emailScratch,
        now,
        timeZone
      )
    : emptySection("email_today", "EMAIL ARRIVED TODAY");
  gaps.push(...emailScratch.filter((g) => g.reason === "tool_failed"));
  const calendarSourceContext = sourceContextMetaFor(rawCalendar);
  const emailSourceContext = sourceContextMetaFor(rawEmail);
  recordSourceAuthGap("calendar_tomorrow", calendarSourceContext, gaps);
  recordSourceAuthGap("email_today", emailSourceContext, gaps);
  const sourceContextDegraded = [
    ...calendarSourceContext.accounts,
    ...emailSourceContext.accounts
  ].some((account) => account.source === "cache");
  const emailSettings = await readEmailSignalSettings(scopedDb, deps);
  const context = contextTokens(tasksReconciliation.lines, commitments.lines);
  const emailSignals = includeEmail
    ? deriveEmailSignals({
        // Same triage filter as the prompt lines: noise/fyi/unknown never seed signals.
        items: filterEmailItems(rawEmail.rawItems ?? [], actionRows.sourceRefs).filter(
          isActionableTriage
        ),
        now,
        context,
        settings: emailSettings
      })
    : [];
  const emailSelected = definition.selected_tool_names.includes("email.listVisibleMessages");
  if (includeEmail && emailSelected && emailSignals.length === 0) {
    gaps.push({ source: "email_today", reason: "empty" });
  }
  const emailToday: Section = {
    key: "email_today",
    label: "EMAIL ARRIVED TODAY",
    lines: emailSignals.slice(0, SECTION_ITEM_CAP).map((s) => sanitizeExternal(s.summary)),
    count: emailSignals.length,
    rawItems: rawEmail.rawItems
  };
  const catchUp = includeEmail
    ? await buildEmailCatchUp(
        scopedDb,
        rawEmail.rawItems ?? [],
        actionRows.sourceRefs,
        deps.connectorSyncAt
      )
    : null;
  const structuredPayload = {
    ...actionRows.payload,
    catchUp,
    ...(plan.present ? { planContext: plan.planContext } : {})
  };

  // ── goals / sports / chats: identical to the morning gathers ─────────────────
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
      format: (row) => sanitizeExternal(row.text)
    },
    gaps,
    now,
    timeZone
  );
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
      localDayField: "createdAt",
      format: (t) =>
        [sanitizeExternal(t.role), sanitizeExternal(t.excerpt)].filter(Boolean).join(": ")
    },
    gaps,
    now,
    timeZone
  );

  // News channel (#31) is reserved but unwired — no block, explicit gap every run.
  gaps.push({ source: "news", reason: "unwired" });

  const sections: Section[] = [tasksReconciliation, commitments, calendarTomorrow, emailToday];
  if (definition.selected_tool_names.includes("goals.list")) {
    sections.push(goals);
  }
  const sportsSelected = definition.selected_tool_names.includes("sports.followedFactsToday");
  if (sportsSelected) {
    sections.push(sports);
  }

  // #1282: same seam as the morning composer (compose.ts) — see the comment there for why
  // the manifests/invoker are injected rather than filtered off `deps.moduleManifests` (J1).
  if (deps.invokeExternalBriefing) {
    const ctx = ctxFor(definition, input);
    const externalContributions = await collectExternalBriefingContributions({
      manifests: deps.externalBriefingManifests ?? [],
      selectedToolNames: definition.selected_tool_names,
      section: "evening",
      actorUserId: ctx.actorUserId,
      requestId: ctx.requestId,
      invoke: deps.invokeExternalBriefing
    });
    const externalModules = buildExternalModulesSection(externalContributions);
    if (externalModules) {
      sections.push(externalModules);
    }
  }

  sections.push(chats);

  const morningPlan = morningPlanSection(input.sameDayMorningMeta);
  if (morningPlan) {
    sections.push(morningPlan);
  }
  sections.push(planSection(plan.planContext, tasksReconciliation.rawItems));

  const hasFreshnessDeps = !!(deps.connectorSyncAt ?? deps.vaultLastWriteAt);
  const sourceTimestamps = hasFreshnessDeps
    ? await resolveBriefingFreshness(
        scopedDb,
        sections.map((s) => s.key),
        now,
        {
          connectorSyncAt: deps.connectorSyncAt,
          vaultLastWriteAt: deps.vaultLastWriteAt
        }
      )
    : undefined;

  const baseMetadata: Record<string, unknown> = {
    taskCompletedCount: lenses.completedToday.length,
    taskSlippedCount: lenses.slipped.length,
    taskCarryCount: lenses.carryingForward.length,
    commitmentCount: commitments.count,
    tomorrowEventCount: tomorrowItems.length,
    emailSignalCount: emailSignals.length,
    emailSignals,
    goalCount: goals.count,
    sportsCount: sports.count,
    chatTurnCount: chats.count,
    morningRunReferenced: morningPlan !== null,
    gaps,
    ...(plan.planSnapshot !== undefined ? { planSnapshot: plan.planSnapshot } : {}),
    // Live/cache provenance per connected account (#729).
    sourceContext: { email: emailSourceContext, calendar: calendarSourceContext },
    ...(sourceTimestamps !== undefined ? { sourceTimestamps } : {})
  };

  const personaBlock = await buildPersonaBlock(scopedDb, definition, deps);
  const messages: ChatTurn[] = [
    {
      role: "user",
      content: [TRUSTED_INSTRUCTIONS_EVENING, personaBlock, ...sections.map(renderExternalBlock)]
        .filter(Boolean)
        .join("\n\n")
    }
  ];
  const synth = await synthesizeWithConfiguredModel(scopedDb, deps, messages);
  if (!synth.ok) {
    return fallbackEvening({
      reason: synth.reason,
      completed: lenses.completedToday.slice(0, LENS_ITEM_CAP).map(lensLine),
      slipped: lenses.slipped.slice(0, LENS_ITEM_CAP).map(lensLine),
      carrying: lenses.carryingForward.slice(0, LENS_ITEM_CAP).map(lensLine),
      attention: [...commitments.lines, ...emailToday.lines],
      tomorrow: calendarTomorrow.lines,
      newsSports: sportsSelected ? sports.lines : [],
      metadata: baseMetadata,
      structuredPayload
    });
  }
  return {
    status: "succeeded",
    summaryText: synth.text,
    sourceMetadata: {
      ...baseMetadata,
      aiModel: {
        id: synth.model.id,
        displayName: synth.model.display_name,
        tier: synth.model.tier
      },
      // Degraded when any source-context account was served from cache (#729); a synthesis
      // failure still routes through fallbackEvening with its own degradedReason.
      degraded: sourceContextDegraded
    },
    structuredPayload
  };
}

// Degraded evening render: mirrors the locked section vocabulary so the Today surface
// can style a degraded run identically, and always ends with the two canned questions.
export function fallbackEvening(args: {
  readonly reason: SynthesisFailureReason;
  readonly completed: readonly string[];
  readonly slipped: readonly string[];
  readonly carrying: readonly string[];
  readonly attention: readonly string[];
  readonly tomorrow: readonly string[];
  readonly newsSports: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly structuredPayload: BriefingStructuredPayloadV1;
}): ComposeResult {
  const H = EVENING_SECTION_HEADERS;
  const block = (header: string, lines: readonly string[], emptyLine: string) =>
    `${header}\n${lines.length > 0 ? lines.map((l) => "- " + l).join("\n") : "- " + emptyLine}`;
  const text = [
    "Evening wrap-up (sources listed without narrative — AI synthesis unavailable).",
    block(H.whatGotDone, args.completed, "(none today)"),
    block(H.whatSlipped, args.slipped, "(none today)"),
    block(H.carryingForward, args.carrying, "(none)"),
    block(H.needsYourAttention, args.attention, "(none today)"),
    block(H.tomorrow, args.tomorrow, "(tomorrow looks clear)"),
    block(H.newsAndSports, args.newsSports, "(quiet day)"),
    EVENING_FALLBACK_QUESTIONS.join("\n")
  ].join("\n\n");
  return {
    status: "succeeded",
    summaryText: text,
    sourceMetadata: {
      ...args.metadata,
      aiModel: null,
      degraded: true,
      degradedReason: args.reason
    },
    structuredPayload: args.structuredPayload
  };
}
