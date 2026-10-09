import {
  EVENING_SECTION_DAY_LABEL,
  TODAY_SECTION_INDEX_LABEL,
  TODAY_SECTION_LINKS
} from "./today-labels.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  eventCoversDay,
  localDay,
  readPlanContext,
  type MeResponse,
  type TaskDto
} from "@moss/shared";
import {
  getBriefingRun,
  getDayPlan,
  listCalendarEvents,
  listBriefingDefinitions,
  listBriefingRuns,
  listTaskLists,
  listTasks,
  startEveningInterview,
  updateTask
} from "../api/client";
import { findDefinition, targetTimeFor } from "../briefings/briefing-settings-model";
import { formatDate, useUserLocale, zonedClockMinutes } from "../locale/locale-format";
import { localTimeToIso } from "./day-plan-review-model.js";
import { useChatAvailable } from "../onboarding/chat-availability";
import { useChatControls } from "../shell/chat-controls-context";
import { readColorMode } from "../theme/color-mode";
import { getWeatherToday } from "../api/weather-client";
import { queryKeys } from "../api/query-keys";
import {
  addDaysToKey,
  buildEveningLede,
  deriveTodayMode,
  parseTargetMinutes,
  effectiveEveningTimeZone,
  effectiveBriefingTimeZone,
  EveningReviewSection,
  EveningSupportSections,
  type EveningLoopDecision,
  latestBriefingRunForToday,
  latestEveningRunForToday,
  scheduleTodayModeRefresh,
  selectActionRowsRun
} from "./evening-mode";
import { splitEveningReport } from "./evening-report";
import { buildTodayHeroContent, splitHeadline, TodayHero } from "./today-hero";
import { parseBriefingFreshness } from "./briefing-freshness";
import { ProactiveCards } from "./proactive-cards";
import { BriefingActionRowsSection } from "./briefing-action-rows";
import { dayPlanReviewUnavailableMessage, MorningBriefingReader } from "./morning-briefing";
import { isEmailSourceStale, TodayEmailRefreshAction } from "./today-email-refresh.js";
import { DayPlanSection } from "./day-plan";
import { TodayDock, TodayRail } from "./today-rail";
import { DayPlanReview } from "./day-plan-review";
import { useDayPlanReview, type DayPlanReviewController } from "./day-plan-review-controller";
import { useEveningPlanning } from "./evening-planning-controller";
import { tomorrowPlanMissing } from "./evening-planning-model";
import { EveningPlanningDialog } from "./evening-planning";
import { TodayWeatherRow } from "./header-weather";
import { TaskDetailsDialog } from "../tasks/task-details-dialog";
import { createEmptyTodayFeed, type TodayFeed } from "./feed-source";
import { ModuleTodayWidgets } from "./module-today-widgets";
import {
  buildHeadline,
  buildLede,
  byStart,
  dueTs,
  eveningHeroKicker,
  firstName,
  isToday,
  greeting,
  morningHeroKicker
} from "./today-labels";
import { isAtRisk, isDoFirst, isDoneToday } from "../tasks/focus";
import { BriefTaskRow } from "./brief-task-row";
import { findChangedBlocks } from "./briefing-callout";
import { OvernightSection } from "./overnight-section";
import { NewsDesk } from "./news-desk";
import "../styles/wellness-1.css";
import "../styles/wellness-2.css";
import "../styles/wellness-3.css";
import "../styles/kit-tasks-modal.css";
import "../styles/kit-today.css";
import "../styles/kit-today-hero.css";
import "../styles/kit-today-timeline.css";
import "../styles/kit-today-desks.css";
import "../styles/kit-today-feeds.css";
import "../styles/kit-today-misc.css";
import "../styles/kit-evening-loops.css";
import "../styles/kit-briefing-reader.css";
import "../styles/kit-day-plan-review.css";
import "../styles/kit-evening-planning.css";
import { GoalsSection } from "./goals-section.js";
import { TodayQuietLine } from "./today-quiet-line.js";

/** Today — the all-day home: an editorial brief over the user's real tasks + calendar. */
export function TodayPage(props: {
  readonly me: MeResponse;
  readonly feed?: TodayFeed;
  readonly wellnessEnabled?: boolean;
  readonly disabledModuleIds?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const chatControls = useChatControls();
  const locale = useUserLocale();
  const chatAvailable = useChatAvailable();
  const feed = props.feed ?? createEmptyTodayFeed();
  const disabledModuleIds = props.disabledModuleIds ?? [];
  const wellnessEnabled = props.wellnessEnabled ?? false;
  const [dialog, setDialog] = useState<{ readonly id: string } | null>(null);
  const [reader, setReader] = useState<{
    readonly definitionId: string;
    readonly runId: string;
    readonly kind?: "morning" | "evening";
    readonly section?: "sources";
  } | null>(null);
  const readerOpener = useRef<HTMLElement | null>(null);
  const [review, setReview] = useState(false);
  const [reviewAttempted, setReviewAttempted] = useState(false);
  const readerBeforeReview = useRef<{ definitionId: string; runId: string } | null>(null);
  const reviewOpener = useRef<HTMLElement | null>(null);
  const [planningAnchor, setPlanningAnchor] = useState<HTMLElement | null>(null);
  const [, forceTodayModeRefresh] = useState(0);
  // The masthead clock and next-event countdown read `now`; tick a re-render each
  // half-minute so they stay honest while the page sits open.
  const [, forceClockTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceClockTick((value) => value + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const tasksQuery = useQuery({ queryKey: queryKeys.tasks.list, queryFn: () => listTasks() });
  const listsQuery = useQuery({ queryKey: queryKeys.tasks.lists, queryFn: listTaskLists });
  const eventsQuery = useQuery({
    queryKey: queryKeys.calendar.list,
    queryFn: () => listCalendarEvents()
  });
  const briefingDefinitionsQuery = useQuery({
    queryKey: queryKeys.briefings.definitions,
    queryFn: listBriefingDefinitions
  });
  const eveningDefinition = findDefinition(
    briefingDefinitionsQuery.data?.definitions ?? [],
    "evening"
  );
  const morningDefinition = findDefinition(
    briefingDefinitionsQuery.data?.definitions ?? [],
    "morning"
  );
  const eveningRunsQuery = useQuery({
    queryKey: queryKeys.briefings.runs(eveningDefinition?.id ?? null),
    queryFn: () => listBriefingRuns(eveningDefinition!.id),
    enabled: eveningDefinition !== undefined
  });
  const morningRunsQuery = useQuery({
    queryKey: queryKeys.briefings.runs(morningDefinition?.id ?? null),
    queryFn: () => listBriefingRuns(morningDefinition!.id),
    enabled: morningDefinition?.enabled === true
  });
  const now = new Date(Date.now());
  const todayKey = localDay(now, locale.timezone);
  const dayPlanQuery = useQuery({
    queryKey: queryKeys.calendar.dayPlan(localDay(now, locale.timezone), locale.timezone),
    queryFn: () => getDayPlan({ date: localDay(now, locale.timezone), timeZone: locale.timezone }),
    retry: false
  });
  const reviewController = useDayPlanReview({
    plan: dayPlanQuery.data?.plan ?? null,
    localDay: todayKey,
    timeZone: locale.timezone,
    morningDefinitionId: morningDefinition?.id ?? null
  });
  const reviewUnavailableMessage = reviewAttempted
    ? dayPlanReviewUnavailableMessage({
        dayPlan: dayPlanQuery.data,
        loading: dayPlanQuery.isPending,
        error: dayPlanQuery.isError
      })
    : null;
  const openDayPlanReview = (anchor: HTMLElement | null, fromReader: boolean) => {
    if (
      dayPlanReviewUnavailableMessage({
        dayPlan: dayPlanQuery.data,
        loading: dayPlanQuery.isPending,
        error: dayPlanQuery.isError
      })
    ) {
      setReviewAttempted(true);
      return;
    }
    setReviewAttempted(false);
    reviewOpener.current = fromReader ? readerOpener.current : anchor;
    readerBeforeReview.current = fromReader ? reader : null;
    if (fromReader) setReader(null);
    setReview(true);
  };
  const todayMode = deriveTodayMode(eveningDefinition, locale, now);
  const eveningTimeZone = effectiveEveningTimeZone(eveningDefinition, locale);
  const latestEveningRun = latestEveningRunForToday(
    eveningRunsQuery.data?.runs ?? [],
    eveningTimeZone,
    now
  );
  const morningTimeZone = effectiveBriefingTimeZone(morningDefinition, locale);
  const latestMorningRun = latestBriefingRunForToday(
    morningRunsQuery.data?.runs ?? [],
    "morning",
    morningTimeZone,
    now
  );
  // Same query key as the reader, so opening the reader reuses this fetch.
  const morningDetailQuery = useQuery({
    queryKey: queryKeys.briefings.run(morningDefinition?.id ?? "", latestMorningRun?.id ?? ""),
    queryFn: () => getBriefingRun(morningDefinition!.id, latestMorningRun!.id),
    enabled: morningDefinition !== undefined && latestMorningRun !== undefined
  });
  const changedSinceLastNight = findChangedBlocks(
    latestMorningRun ? readPlanContext(latestMorningRun.structuredPayload) : null,
    morningDetailQuery.data?.plan?.current ?? null
  );
  useEffect(
    () =>
      scheduleTodayModeRefresh(eveningDefinition, locale, () => {
        forceTodayModeRefresh((value) => value + 1);
      }),
    [
      eveningDefinition?.enabled,
      eveningDefinition?.id,
      eveningDefinition?.scheduleMetadata.targetTime,
      eveningDefinition?.scheduleMetadata.timezone,
      locale.timezone,
      todayMode
    ]
  );
  const eveningInterviewMutation = useMutation({
    mutationFn: () => startEveningInterview({ briefingRunId: latestEveningRun?.id }),
    onSuccess: () => {
      // The seeded interview turn arrives via the global chat SSE stream; just
      // refresh the thread list. The drawer is already open (see onPrep below).
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads() });
    },
    // #891: the seed POST reaches submitTurn, which needs a configured chat model
    // and can reject (unconfigured model, provider error, rate limit). Keep a
    // console trail; the drawer is already open regardless, so the failure is not
    // a silent no-op the way it was when opening was gated behind onSuccess.
    onError: (error) => {
      console.error("evening interview failed to start", error);
    }
  });
  const toggleMutation = useMutation({
    mutationFn: (task: TaskDto) =>
      updateTask(task.id, { status: task.status === "done" ? "todo" : "done" }),
    onSuccess: () => {
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
      }, 500);
    }
  });
  const loopMutation = useMutation({
    mutationFn: (input: { taskId: string; decision: EveningLoopDecision }) => {
      const { decision } = input;
      if (decision.kind === "drop") return updateTask(input.taskId, { status: "archived" });
      const day =
        decision.kind === "tomorrow"
          ? addDaysToKey(localDay(new Date(), locale.timezone), 1)
          : decision.date;
      const dueAt = localTimeToIso(day, "00:00", locale.timezone);
      if (dueAt === null) return Promise.reject(new Error("invalid day"));
      return updateTask(input.taskId, { dueAt });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
    }
  });
  const theme = readColorMode();
  const weatherQuery = useQuery({
    queryKey: queryKeys.weather.today,
    queryFn: getWeatherToday,
    staleTime: 30 * 60 * 1000
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const events = eventsQuery.data?.events ?? [];
  const lists = listsQuery.data?.lists ?? [];

  const open = tasks.filter((t) => t.parentTaskId === null && t.status === "todo");
  const actionRowsRun = selectActionRowsRun(todayMode, latestMorningRun, latestEveningRun);
  const actionRowsLoading =
    todayMode === "day"
      ? briefingDefinitionsQuery.isPending ||
        (morningDefinition?.enabled === true && morningRunsQuery.isPending)
      : eveningRunsQuery.isPending;
  // "Priorities" = Do First (important + urgent); "At risk" = due today/soon or overdue.
  const priorities = open.filter(isDoFirst);
  const atRisk = open.filter((t) => isAtRisk(t, locale.timezone));
  const completedToday = tasks.filter((t) => isDoneToday(t, locale.timezone));
  const todayEvents = useMemo(
    () => events.filter((e) => isToday(e, locale.timezone)).sort(byStart),
    [events, locale.timezone]
  );
  const tomorrowKey = addDaysToKey(localDay(now, locale.timezone), 1);
  const tomorrowEvents = useMemo(
    () => events.filter((e) => eventCoversDay(e, tomorrowKey, locale.timezone)).sort(byStart),
    [events, locale.timezone, tomorrowKey]
  );
  const tomorrowPlanQuery = useQuery({
    queryKey: queryKeys.calendar.dayPlan(tomorrowKey, locale.timezone),
    queryFn: () => getDayPlan({ date: tomorrowKey, timeZone: locale.timezone }),
    retry: false
  });
  const eveningReviewRef = useRef<DayPlanReviewController | null>(null);
  const evening = useEveningPlanning({
    active: planningAnchor !== null,
    tomorrowKey,
    todayKey,
    timeZone: locale.timezone,
    queryPlan: tomorrowPlanQuery.data?.plan ?? null,
    planMissing: tomorrowPlanMissing(tomorrowPlanQuery.data, tomorrowPlanQuery.error),
    todayPlan: dayPlanQuery.data?.plan ?? null,
    tasks,
    unavailableTaskIds: tomorrowPlanQuery.data?.unavailableTaskIds ?? [],
    tomorrowEvents,
    sourceRunId: latestEveningRun?.id ?? null,
    getReview: () => eveningReviewRef.current
  });
  const eveningReview = useDayPlanReview({
    plan: evening.plan,
    localDay: tomorrowKey,
    timeZone: locale.timezone,
    morningDefinitionId: null
  });
  eveningReviewRef.current = eveningReview;
  const tomorrowTasks = tasks
    .filter(
      (task) =>
        task.status === "todo" &&
        task.dueAt !== null &&
        localDay(task.dueAt, locale.timezone) === tomorrowKey
    )
    .slice(0, 3);
  const upcoming = useMemo(
    () => todayEvents.filter((e) => new Date(e.endsAt).getTime() >= Date.now()),
    [todayEvents]
  );
  const doneToday = completedToday.length;

  // "Start here": top open tasks by priority, then nearest due.
  const startHere = [...open]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || dueTs(a) - dueTs(b))
    .slice(0, 3);
  const looseEnds = atRisk.slice(0, 5);
  const assessmentShown =
    todayMode === "evening"
      ? eveningDefinition?.enabled === true
      : briefingDefinitionsQuery.isPending || morningDefinition?.enabled === true;

  const lede =
    todayMode === "evening"
      ? buildEveningLede(doneToday, atRisk.length, tomorrowEvents.length)
      : buildLede(priorities.length, atRisk.length, todayEvents.length);
  // Priorities and at-risk overlap (a Do First task can also be due today), so the
  // masthead count dedupes by id: it reads as "N need you", not a double-counted sum.
  const needsYou = new Set([...priorities, ...atRisk].map((t) => t.id)).size;
  const upcomingLeft = upcoming.filter((e) => new Date(e.startsAt).getTime() >= now.getTime());
  const headline = buildHeadline(todayMode, needsYou, upcomingLeft.length, doneToday);
  // A Moss-created block (e.g. a preparation block) is itself a calendar
  // event, so it can sit first in `upcoming` right before the meeting it
  // precedes. The card is about the meeting, so skip Moss blocks here.
  const nextEvent = upcoming.find((e) => !e.isMossBlock);
  const nextStarted = nextEvent ? new Date(nextEvent.startsAt).getTime() <= now.getTime() : false;

  const morningLoading =
    briefingDefinitionsQuery.isPending ||
    (morningDefinition?.enabled === true && morningRunsQuery.isPending);
  const morningReadable =
    latestMorningRun && latestMorningRun.summaryText.trim() && morningDefinition?.id
      ? { run: latestMorningRun, definitionId: morningDefinition.id }
      : null;
  const morningSplit = morningReadable ? splitHeadline(morningReadable.run.summaryText) : null;
  const morningFreshness = latestMorningRun
    ? parseBriefingFreshness(latestMorningRun.sourceMetadata)
    : null;
  // Each evening slot gets its own part of the report: the hero takes the
  // opening verdict, the recap and open-loops sections take their own sections.
  const eveningReport = latestEveningRun ? splitEveningReport(latestEveningRun.summaryText) : null;
  const eveningSplit = eveningReport?.verdict ? splitHeadline(eveningReport.verdict) : null;
  const openMorningReader = (anchor: HTMLElement) => {
    const runId = latestMorningRun?.id;
    if (!morningDefinition || !runId) return;
    readerOpener.current = anchor;
    // Settle the day plan refetch first so the reader classifies the block
    // placement it actually opens with, not a stale pending one still in
    // cache. Still opens on refresh failure, from whatever data is cached.
    void dayPlanQuery.refetch().finally(() => {
      setReader({ definitionId: morningDefinition.id, runId });
    });
  };
  const openEveningReader = (anchor: HTMLElement, section?: "sources") => {
    const runId = latestEveningRun?.id;
    if (!eveningDefinition || !runId) return;
    readerOpener.current = anchor;
    setReader({ definitionId: eveningDefinition.id, runId, kind: "evening", section });
  };
  const eveningTargetTime = eveningDefinition ? targetTimeFor(eveningDefinition, "evening") : "";
  const morningTargetTime = targetTimeFor(morningDefinition, "morning");
  const morningTargetMinutes = parseTargetMinutes(morningTargetTime) ?? 7 * 60;
  const heroContent = buildTodayHeroContent({
    mode: todayMode,
    assessmentShown,
    morningLoading,
    morningRun: latestMorningRun,
    morningDefinitionId: morningDefinition?.id ?? null,
    // Withheld until definitions load, so a missing definition is not read as "switched off".
    morningSchedule: briefingDefinitionsQuery.isPending
      ? undefined
      : {
          enabled: morningDefinition?.enabled === true,
          targetTime: morningTargetTime,
          pastTarget: (zonedClockMinutes(now, morningTimeZone) ?? 0) >= morningTargetMinutes
        },
    morningSplit,
    morningFreshness,
    eveningRun: latestEveningRun,
    eveningSplit,
    eveningLoading: eveningRunsQuery.isPending,
    eveningTargetTime,
    fallbackTop: headline.top,
    fallbackAccent: headline.accent,
    ledeHtml: lede,
    locale,
    onFeedbackChanged: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.briefings.runs(eveningDefinition?.id ?? "")
      }),
    onOpenReader: openMorningReader,
    onOpenEveningReader: openEveningReader
  });
  const sectionLinks = (
    <nav aria-label="Sections" className="cmd-sections today-hero__sections">
      <span className="today-hero__sections-label">{TODAY_SECTION_INDEX_LABEL}</span>
      {TODAY_SECTION_LINKS.map((link, index) => (
        <a key={link.href} href={link.href}>
          {todayMode === "evening" && index === 0 ? EVENING_SECTION_DAY_LABEL : link.label}
        </a>
      ))}
    </nav>
  );
  // Day mode folds the empty personal sections into one quiet line, once
  // everything they read has loaded. Any one with content restores them all.
  const personalSectionsEmpty =
    todayMode === "day" &&
    !tasksQuery.isPending &&
    !morningLoading &&
    // The evening runs query stays idle (pending forever) without a definition.
    (eveningDefinition === undefined || !eveningRunsQuery.isPending) &&
    morningReadable === null &&
    startHere.length === 0 &&
    !latestEveningRun?.summaryText.trim();
  const railSection = (
    <TodayRail
      mode={todayMode}
      now={now}
      locale={locale}
      nextEvent={
        nextEvent
          ? {
              id: nextEvent.id,
              title: nextEvent.title,
              startsAt: nextEvent.startsAt,
              endsAt: nextEvent.endsAt,
              location: nextEvent.location ?? null
            }
          : null
      }
      precedingEvents={todayEvents}
      nextStarted={nextStarted}
      changedSinceLastNight={changedSinceLastNight}
      onNavigate={(path) => navigate(path)}
      showEveningReview={
        eveningDefinition?.enabled === true && todayMode === "day" && !personalSectionsEmpty
      }
      showEveningPrep={eveningDefinition?.enabled === true && todayMode === "evening"}
      latestEveningRun={latestEveningRun}
      eveningRunsPending={eveningRunsQuery.isPending}
      eveningTargetTime={eveningTargetTime}
      onEveningFeedback={() => {
        if (eveningDefinition) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.briefings.runs(eveningDefinition.id)
          });
        }
      }}
      interviewPending={eveningInterviewMutation.isPending}
      onPrep={() => {
        // #891: open the drawer immediately rather than waiting for the
        // seed POST to resolve; the seeded turn streams in via SSE.
        chatControls.openChat();
        eveningInterviewMutation.mutate();
      }}
      onPlan={setPlanningAnchor}
      tomorrowLabel={formatDate(`${tomorrowKey}T12:00:00Z`, locale, {
        weekday: "long",
        month: "long",
        day: "numeric"
      })}
      tomorrowEvents={tomorrowEvents}
      tomorrowTasks={tomorrowTasks}
      onOpenTask={(id) => setDialog({ id })}
      wellnessEnabled={wellnessEnabled}
      theme={theme}
      timeZone={locale.timezone}
      disabledModuleIds={disabledModuleIds}
    />
  );
  const startHereSection = (
    <section className="jds-brief" id="start-here">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Start here</span>
      </div>
      <div className="jds-brief__title">The few things that matter most</div>
      <div className="top3" style={{ marginTop: 4 }}>
        {startHere.length > 0 ? (
          startHere.map((task) => (
            <BriefTaskRow
              key={task.id}
              task={task}
              onToggle={() => toggleMutation.mutate(task)}
              onOpen={() => setDialog({ id: task.id })}
            />
          ))
        ) : (
          <p className="cmd-empty" role="status">
            Nothing pressing right now.
          </p>
        )}
      </div>
      {startHere.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <span className="jds-why">
            <Info size={12} aria-hidden="true" />
            Ranked by priority, then by what&apos;s due first.
          </span>
        </div>
      ) : null}
    </section>
  );

  const userFirstName = props.me.user.name.trim()
    ? firstName(props.me.user.name, props.me.user.email)
    : null;

  // The hero stands outside .cmd-wrap: it breaks out of the surface padding
  // to span the content region in both sidebar states, while the wrap below
  // keeps its padded max-width grid.
  return (
    <>
      <TodayHero
        mode={todayMode}
        eyebrow={
          todayMode === "evening"
            ? eveningHeroKicker(userFirstName)
            : morningDefinition?.enabled === true
              ? morningHeroKicker(userFirstName, now)
              : userFirstName
                ? `${greeting()}, ${userFirstName}`
                : greeting()
        }
        headline={heroContent.headline}
        summary={heroContent.summary}
        preparedAt={heroContent.preparedAt}
        notReadyReason={heroContent.notReadyReason}
        readerControl={
          heroContent.readerControl ||
          (todayMode === "day" &&
            morningDefinition?.enabled &&
            isEmailSourceStale(morningFreshness)) ? (
            <>
              {heroContent.readerControl}
              {todayMode === "day" && morningDefinition?.enabled && morningFreshness ? (
                <TodayEmailRefreshAction
                  definitionId={morningDefinition.id}
                  freshness={morningFreshness}
                />
              ) : null}
            </>
          ) : null
        }
        weather={
          <TodayWeatherRow
            weather={weatherQuery.data?.data}
            mode={todayMode}
            isPending={weatherQuery.isPending}
            isError={weatherQuery.isError}
          />
        }
        sectionLinks={sectionLinks}
      />

      <div className="cmd-wrap">
        <div className="cmd-grid" data-mode={todayMode}>
          <TodayDock
            wellnessEnabled={wellnessEnabled}
            theme={theme}
            timeZone={locale.timezone}
            disabledModuleIds={disabledModuleIds}
          />

          <div className="cmd-main">
            {todayMode === "evening" && eveningDefinition?.enabled ? (
              <>
                <EveningReviewSection
                  kind="primary"
                  run={latestEveningRun}
                  loading={eveningRunsQuery.isPending}
                  locale={locale}
                  targetTime={eveningTargetTime}
                  onFeedbackChanged={() => {
                    if (eveningDefinition) {
                      void queryClient.invalidateQueries({
                        queryKey: queryKeys.briefings.runs(eveningDefinition.id)
                      });
                    }
                  }}
                  completedToday={completedToday}
                  recapProse={eveningReport?.recap ?? ""}
                  recapDateLabel={formatDate(now.toISOString(), locale, {
                    weekday: "long",
                    month: "long",
                    day: "numeric"
                  })}
                  onOpenTask={(id) => setDialog({ id })}
                />
                <EveningSupportSections
                  openLoopsDek={eveningReport?.openLoops || null}
                  carryingForward={looseEnds}
                  locale={locale}
                  busyTaskId={
                    loopMutation.isPending ? (loopMutation.variables?.taskId ?? null) : null
                  }
                  onOpenTask={(id) => setDialog({ id })}
                  onDecide={(taskId, decision) => loopMutation.mutateAsync({ taskId, decision })}
                />
              </>
            ) : null}

            {todayMode === "evening" ? startHereSection : null}

            {todayMode === "day" ? (
              <DayPlanSection
                dayPlan={dayPlanQuery.data}
                events={events}
                locale={locale}
                now={now}
                loading={dayPlanQuery.isPending}
                error={dayPlanQuery.isError}
                calendarError={eventsQuery.isError}
                editorial
                todayLayout
                onOpenTask={(id) => setDialog({ id })}
                onReview={(anchor) => {
                  openDayPlanReview(anchor, false);
                }}
              />
            ) : null}
            {reviewUnavailableMessage && !reader ? (
              <p className="cmd-empty" role="status">
                {reviewUnavailableMessage}
              </p>
            ) : null}

            {todayMode === "day" ? (
              personalSectionsEmpty ? (
                <TodayQuietLine />
              ) : (
                startHereSection
              )
            ) : null}

            <div id="needs-you">
              <BriefingActionRowsSection
                run={actionRowsRun}
                loading={actionRowsLoading}
                tasks={tasks}
                looseEnds={looseEnds}
                locale={locale}
                chatAvailable={chatAvailable}
                onOpenTask={(id) => setDialog({ id })}
              />
            </div>

            {feed.overnight.length > 0 ? <OvernightSection items={feed.overnight} /> : null}

            <div id="goals">
              <GoalsSection />
            </div>

            <ProactiveCards />
          </div>
          {railSection}
          <div id="widgets">
            <ModuleTodayWidgets slot="brief" disabledModuleIds={disabledModuleIds} />
          </div>
          <div id="news">
            {feed.news.length > 0 || feed.interests.length > 0 ? (
              <NewsDesk news={feed.news} interests={feed.interests} />
            ) : null}
          </div>
          <div id="sports">
            <ModuleTodayWidgets slot="sports" disabledModuleIds={disabledModuleIds} />
          </div>
        </div>
        {dialog ? (
          <TaskDetailsDialog
            open
            taskId={dialog.id}
            currentUserLabel="You"
            lists={lists}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {reader ? (
          <MorningBriefingReader
            kind={reader.kind}
            initialSection={reader.section}
            definitionId={reader.definitionId}
            initialRunId={reader.runId}
            runs={
              (reader.kind === "evening" ? eveningRunsQuery : morningRunsQuery).data?.runs ?? []
            }
            tasks={tasks}
            locale={locale}
            dayPlan={dayPlanQuery.data}
            events={events}
            now={now}
            dayPlanLoading={dayPlanQuery.isPending}
            dayPlanError={dayPlanQuery.isError}
            calendarError={eventsQuery.isError}
            opener={readerOpener.current}
            onClose={() => setReader(null)}
            controller={reviewController}
            onOpenTask={(id) => {
              // The task dialog lives in the app root, which the reader holds
              // inert: close the reader first so the dialog can take focus.
              setReader(null);
              setDialog({ id });
            }}
            onReview={() => {
              // The review replaces the reader: one dialog owns inert and focus.
              openDayPlanReview(null, true);
            }}
          />
        ) : null}
        {planningAnchor ? (
          <EveningPlanningDialog
            evening={evening}
            review={eveningReview}
            tasks={tasks}
            taskSummaries={tomorrowPlanQuery.data?.tasks ?? []}
            unavailableTaskIds={tomorrowPlanQuery.data?.unavailableTaskIds ?? []}
            tomorrowEvents={tomorrowEvents}
            completedToday={completedToday}
            locale={locale}
            now={now}
            tomorrowKey={tomorrowKey}
            eveningRun={latestEveningRun}
            opener={planningAnchor}
            onClose={() => setPlanningAnchor(null)}
            onOpenTask={(id) => {
              setPlanningAnchor(null);
              setDialog({ id });
            }}
          />
        ) : null}
        {review && dayPlanQuery.data?.plan ? (
          <DayPlanReview
            controller={reviewController}
            plan={dayPlanQuery.data.plan}
            tasks={dayPlanQuery.data.tasks}
            unavailableTaskIds={dayPlanQuery.data.unavailableTaskIds}
            events={events}
            locale={locale}
            now={now}
            opener={reviewOpener.current}
            onClose={() => setReview(false)}
            onSelectBriefingTab={() => {
              // Back to the remembered run; from Today alone, just close.
              setReview(false);
              if (readerBeforeReview.current !== null) setReader(readerBeforeReview.current);
            }}
            onOpenTask={(id) => {
              // Same inert-root rule as the reader: the review closes first.
              setReview(false);
              setDialog({ id });
            }}
          />
        ) : null}
      </div>
    </>
  );
}
