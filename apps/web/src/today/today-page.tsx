import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { localDay, type MeResponse, type TaskDto } from "@moss/shared";
import {
  getDayPlan,
  getOnboardingStatus,
  listCalendarEvents,
  listBriefingDefinitions,
  listBriefingRuns,
  listTaskLists,
  listTasks,
  startEveningInterview,
  updateTask
} from "../api/client";
import { findDefinition, targetTimeFor } from "../briefings/briefing-settings-model";
import { useUserLocale } from "../locale/locale-format";
import { hasConnectedProvider } from "../onboarding/chat-availability";
import { useChatControls } from "../shell/chat-controls-context";
import { readColorMode } from "../theme/color-mode";
import { getWeatherToday } from "../api/weather-client";
import { queryKeys } from "../api/query-keys";
import {
  addDaysToKey,
  buildEveningLede,
  deriveTodayMode,
  effectiveEveningTimeZone,
  effectiveBriefingTimeZone,
  EveningSupportSections,
  latestBriefingRunForToday,
  latestEveningRunForToday,
  scheduleTodayModeRefresh,
  selectActionRowsRun
} from "./evening-mode";
import { buildTodayHeroContent, splitHeadline, TodayHero } from "./today-hero";
import { parseBriefingFreshness } from "./briefing-freshness";
import { ProactiveCards } from "./proactive-cards";
import { BriefingActionRowsSection } from "./briefing-action-rows";
import { MorningBriefingReader } from "./morning-briefing";
import { DayPlanSection } from "./day-plan";
import { TodayRail } from "./today-rail";
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
  datelineLabel,
  driftOf,
  dueTs,
  greeting,
  isToday,
  timeLabel
} from "./today-labels";
import { isAtRisk, isDoFirst, isDoneToday } from "../tasks/focus";
import { BriefTaskRow } from "./brief-task-row";
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
import "../styles/kit-briefing-reader.css";
import "../styles/kit-day-plan-review.css";
import "../styles/kit-evening-planning.css";
import { GoalsSection } from "./goals-section.js";

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
  const onboardingStatusQuery = useQuery({
    queryKey: queryKeys.onboarding.status,
    queryFn: getOnboardingStatus,
    retry: false
  });
  const feed = props.feed ?? createEmptyTodayFeed();
  const disabledModuleIds = props.disabledModuleIds ?? [];
  const wellnessEnabled = props.wellnessEnabled ?? false;
  const [dialog, setDialog] = useState<{ readonly id: string } | null>(null);
  const [reader, setReader] = useState<{
    readonly definitionId: string;
    readonly runId: string;
  } | null>(null);
  const readerOpener = useRef<HTMLElement | null>(null);
  const [review, setReview] = useState(false);
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
    () => events.filter((e) => localDay(e.startsAt, locale.timezone) === tomorrowKey).sort(byStart),
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
  // A row of four zeros is noise, not signal — the hero lede already says the day
  // is clear. Show the stat shortcuts only once at least one tile carries a count.
  const hasStatSignal =
    priorities.length > 0 || atRisk.length > 0 || todayEvents.length > 0 || doneToday > 0;
  // Priorities and at-risk overlap (a Do First task can also be due today), so the
  // masthead count dedupes by id: it reads as "N need you", not a double-counted sum.
  const needsYou = new Set([...priorities, ...atRisk].map((t) => t.id)).size;
  const upcomingLeft = upcoming.filter((e) => new Date(e.startsAt).getTime() >= now.getTime());
  const headline = buildHeadline(todayMode, needsYou, upcomingLeft.length, doneToday);
  const nextEvent = upcoming[0];
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
  const eveningSplit =
    latestEveningRun && latestEveningRun.summaryText.trim()
      ? splitHeadline(latestEveningRun.summaryText)
      : null;
  const openMorningReader = (anchor: HTMLElement) => {
    const runId = latestMorningRun?.id;
    if (!morningDefinition || !runId) return;
    readerOpener.current = anchor;
    setReader({ definitionId: morningDefinition.id, runId });
  };
  const eveningTargetTime = eveningDefinition ? targetTimeFor(eveningDefinition, "evening") : "";
  const heroContent = buildTodayHeroContent({
    mode: todayMode,
    assessmentShown,
    morningLoading,
    morningRun: latestMorningRun,
    morningDefinitionId: morningDefinition?.id ?? null,
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
    onOpenReader: openMorningReader
  });

  // The hero stands outside .cmd-wrap: it breaks out of the surface padding
  // to span the content region in both sidebar states, while the wrap below
  // keeps its padded max-width grid.
  return (
    <>
      <TodayHero
        mode={todayMode}
        eyebrow={`${greeting()} · ${datelineLabel(now, locale)}`}
        headline={heroContent.headline}
        summary={heroContent.summary}
        preparedAt={heroContent.preparedAt}
        readerControl={heroContent.readerControl}
        weather={
          <TodayWeatherRow
            weather={weatherQuery.data?.data}
            mode={todayMode}
            isPending={weatherQuery.isPending}
            isError={weatherQuery.isError}
          />
        }
      />

      <div className="cmd-wrap">
        <nav aria-label="Sections" className="cmd-sections">
          {assessmentShown ? <a href="#assessment">Assessment</a> : null}
          <a href="#start-here">Start</a> <a href="#weather">Weather</a>
          <a href="#schedule">Schedule</a> <a href="#needs-you">Needs you</a>
          <a href="#widgets">Widgets</a> <a href="#goals">Goals</a>
          {looseEnds.length > 0 ? <a href="#loose-ends">Loose ends</a> : null}
        </nav>

        <div className="cmd-grid">
          <TodayRail
            now={now}
            locale={locale}
            nextEvent={
              nextEvent
                ? { title: nextEvent.title, startsAt: nextEvent.startsAt, endsAt: nextEvent.endsAt }
                : null
            }
            nextStarted={nextStarted}
            hasStatSignal={hasStatSignal}
            prioritiesCount={priorities.length}
            atRiskCount={atRisk.length}
            eventsCount={todayEvents.length}
            doneToday={doneToday}
            agenda={upcoming.map((event) => ({
              id: event.id,
              time: timeLabel(event.startsAt, locale),
              title: event.title,
              location: event.location
            }))}
            onNavigate={(path) => navigate(path)}
            showEveningReview={eveningDefinition?.enabled === true && todayMode === "day"}
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
            wellnessEnabled={wellnessEnabled}
            theme={theme}
            timeZone={locale.timezone}
            disabledModuleIds={disabledModuleIds}
          />

          <div className="cmd-main">
            {todayMode === "evening" && eveningDefinition?.enabled ? (
              <>
                <EveningSupportSections
                  completedToday={completedToday}
                  carryingForward={looseEnds}
                  tomorrowEvents={tomorrowEvents}
                  tomorrowTasks={tomorrowTasks}
                  locale={locale}
                  renderTask={(task) => (
                    <BriefTaskRow
                      key={task.id}
                      task={task}
                      onToggle={() => toggleMutation.mutate(task)}
                      onOpen={() => setDialog({ id: task.id })}
                    />
                  )}
                />
              </>
            ) : null}

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

            <DayPlanSection
              dayPlan={dayPlanQuery.data}
              events={events}
              locale={locale}
              now={now}
              loading={dayPlanQuery.isPending}
              error={dayPlanQuery.isError}
              calendarError={eventsQuery.isError}
              editorial
              dateline={datelineLabel(now, locale)}
              onOpenTask={(id) => setDialog({ id })}
              onReview={(anchor) => {
                reviewOpener.current = anchor;
                setReview(true);
              }}
            />

            <div id="needs-you">
              <BriefingActionRowsSection
                run={actionRowsRun}
                loading={actionRowsLoading}
                tasks={tasks}
                locale={locale}
                chatAvailable={hasConnectedProvider(onboardingStatusQuery.data)}
                onOpenTask={(id) => setDialog({ id })}
              />
            </div>

            {feed.overnight.length > 0 ? <OvernightSection items={feed.overnight} /> : null}

            <div id="widgets">
              <ModuleTodayWidgets slot="brief" disabledModuleIds={disabledModuleIds} />
            </div>
            {feed.news.length > 0 || feed.interests.length > 0 ? (
              <NewsDesk news={feed.news} interests={feed.interests} />
            ) : null}

            <div id="goals">
              <GoalsSection />
            </div>

            {looseEnds.length > 0 ? (
              <section className="jds-brief" id="loose-ends">
                <div className="jds-brief__head">
                  <span className="jds-brief__kicker">Loose ends</span>
                </div>
                <div className="jds-brief__title">Things I'm keeping an eye on</div>
                <div className="loose">
                  {looseEnds.map((task) => {
                    const drift = driftOf(task, locale.timezone);
                    return (
                      <div className="jds-task" key={task.id}>
                        <span className="jds-task__check">
                          <Flag size={15} aria-hidden="true" />
                        </span>
                        <button
                          type="button"
                          className="jds-task__main"
                          onClick={() => setDialog({ id: task.id })}
                        >
                          <div className="jds-task__title">{task.title}</div>
                          <div className="jds-task__meta">
                            <span className={`jds-drift jds-drift--${drift}`}>
                              <span className="jds-drift__dot" />
                              {drift === "overdue" ? "Overdue" : "At risk"}
                            </span>
                            <span className="jds-task__source">{task.source}</span>
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <ProactiveCards />
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
            definitionId={reader.definitionId}
            initialRunId={reader.runId}
            runs={morningRunsQuery.data?.runs ?? []}
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
              reviewOpener.current = readerOpener.current;
              setReader(null);
              setReview(true);
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
