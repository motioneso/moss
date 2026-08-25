import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Flag,
  HeartPulse,
  Info,
  Pill,
  Target
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { localDay, type BriefingRunDto, type MeResponse, type TaskDto } from "@moss/shared";
import { AgendaRow, Card, Masthead, MastheadClock, MastheadDateline, StatTile } from "@moss/ui";

import {
  createWellnessCheckin,
  getOnboardingStatus,
  getMedicationSchedule,
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
import { MedToday } from "../wellness/wellness-today";
import { ManageMedsModal } from "../wellness/manage-meds-modal";
import { CheckinModal, type CheckinFormValue } from "../wellness/checkin-modal";
import { queryKeys } from "../api/query-keys";
import {
  addDaysToKey,
  buildEveningLede,
  deriveTodayMode,
  effectiveEveningTimeZone,
  effectiveBriefingTimeZone,
  EveningPrepCard,
  EveningReviewSection,
  EveningSupportSections,
  BriefingProse,
  latestBriefingRunForToday,
  latestEveningRunForToday,
  scheduleTodayModeRefresh,
  selectActionRowsRun
} from "./evening-mode";
import { BriefingStaleBanner, parseBriefingFreshness } from "./briefing-freshness";
import { ProactiveCards } from "./proactive-cards";
import { BriefingActionRowsSection } from "./briefing-action-rows";
import { TaskDetailsDialog } from "../tasks/task-details-dialog";
import { createEmptyTodayFeed, type TodayFeed } from "./feed-source";
import { ModuleTodayWidgets } from "./module-today-widgets";
import {
  ampm,
  buildHeadline,
  buildLede,
  byStart,
  countdownLabel,
  datelineLabel,
  driftOf,
  dueTs,
  durationLabel,
  eventCaptureText,
  firstName,
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
import "../styles/kit-today-feeds.css";
import "../styles/kit-today-misc.css";
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
  const [medsModalOpen, setMedsModalOpen] = useState(false);
  const [manageMedsOpen, setManageMedsOpen] = useState(false);
  const [checkinModalOpen, setCheckinModalOpen] = useState(false);
  const medScheduleQuery = useQuery({
    queryKey: queryKeys.wellness.schedule(localDay(new Date(), locale.timezone)),
    queryFn: () => getMedicationSchedule(localDay(new Date(), locale.timezone)),
    enabled: wellnessEnabled
  });
  const medScheduledSlots = (medScheduleQuery.data?.slots ?? []).filter((s) => !s.asNeeded);
  const medTaken = medScheduledSlots.filter((s) => s.status === "taken").length;
  const medTotal = medScheduledSlots.length;
  const medsAllTaken = medTotal > 0 && medTaken === medTotal;
  const medsNoneLogged = medTotal > 0 && medTaken === 0;
  const createCheckinMutation = useMutation({
    mutationFn: (val: CheckinFormValue) =>
      createWellnessCheckin({
        feelingCore: val.emotion,
        feelingSecondary: val.feeling,
        feelingTertiary: null,
        sensations: val.sensations,
        intensity: val.intensity,
        note: val.note || null,
        identifiedVia: "wheel"
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.checkins });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.insights });
      setCheckinModalOpen(false);
    }
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

  const name = firstName(props.me.user.name, props.me.user.email);
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

  return (
    <div className="cmd-wrap">
      {/* Folio column (Ben 2026-07-09 /today): dateline sits as a top-right folio stacked over
          the clock, pinned via Masthead's aside slot, rather than its own line above the row. */}
      <Masthead
        eyebrow={
          <>
            {greeting()}, {name}
          </>
        }
        title={headline.top}
        accent={headline.accent}
        lede={<span dangerouslySetInnerHTML={{ __html: lede }} />}
        aside={
          <>
            <MastheadDateline>{datelineLabel(now, locale)}</MastheadDateline>
            {/* PM is a dot floating left of the first digit, not an "am/pm" suffix (Ben
                2026-07-08); AM shows no dot. MastheadClock renders it as a real element so it
                still carries a native "PM" hover tooltip under aria-hidden. */}
            <MastheadClock
              time={timeLabel(now.toISOString(), locale)}
              pm={ampm(now.toISOString(), locale) === "pm"}
            />
          </>
        }
      />

      <div className="cmd-grid">
        <div>
          {todayMode === "evening" && eveningDefinition?.enabled ? (
            <>
              <EveningReviewSection
                kind="primary"
                run={latestEveningRun}
                loading={eveningRunsQuery.isPending}
                locale={locale}
                targetTime={targetTimeFor(eveningDefinition, "evening")}
                onFeedbackChanged={() =>
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.briefings.runs(eveningDefinition.id)
                  })
                }
              />
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

          {todayMode === "day" &&
          (briefingDefinitionsQuery.isPending || morningDefinition?.enabled) ? (
            <MorningBriefingSection
              run={latestMorningRun}
              loading={
                briefingDefinitionsQuery.isPending ||
                (morningDefinition?.enabled === true && morningRunsQuery.isPending)
              }
            />
          ) : null}

          <section className="jds-brief">
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
                <p className="cmd-empty">Nothing pressing right now.</p>
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

          <BriefingActionRowsSection
            run={actionRowsRun}
            loading={actionRowsLoading}
            tasks={tasks}
            locale={locale}
            chatAvailable={hasConnectedProvider(onboardingStatusQuery.data)}
            onOpenTask={(id) => setDialog({ id })}
          />

          {feed.overnight.length > 0 ? <OvernightSection items={feed.overnight} /> : null}

          <section className="jds-brief">
            <div className="jds-brief__head">
              <span className="jds-brief__kicker">Walking the day</span>
            </div>
            <div className="jds-brief__title">What's on the calendar</div>
            {todayEvents.length > 0 ? (
              <div className="day-list">
                {todayEvents.map((event) => (
                  <div
                    className="day-ev"
                    key={event.id}
                    data-jarvis-capture-text={`Today: ${eventCaptureText(event, locale)}`}
                  >
                    <div className="day-ev__t">
                      {timeLabel(event.startsAt, locale)}
                      <span className="ap"> {ampm(event.startsAt, locale)}</span>
                    </div>
                    <div>
                      <div className="day-ev__title">{event.title}</div>
                      {event.location ? (
                        <div className="day-ev__where">{event.location}</div>
                      ) : null}
                    </div>
                    <div className="day-ev__who">{durationLabel(event)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="cmd-empty">No events today. Enjoy the free time!</p>
            )}
          </section>

          <ModuleTodayWidgets disabledModuleIds={disabledModuleIds} />
          {feed.news.length > 0 || feed.interests.length > 0 ? (
            <NewsDesk news={feed.news} interests={feed.interests} />
          ) : null}

          <GoalsSection />

          {looseEnds.length > 0 ? (
            <section className="jds-brief">
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

        {/* .cmd-aside is the full-height rail carrying the column keyline; the sticky
            content lives in __inner so the border grows to the main column's bottom while
            the cards stay pinned at top (Ben 2026-07-07: border stopped mid-scroll). */}
        <aside className="cmd-aside">
          <div className="cmd-aside__inner">
            {nextEvent ? (
              <div className="cmd-next">
                <div className="cmd-next__k">{nextStarted ? "Now · ends in" : "Next event in"}</div>
                <div className="cmd-next__v">
                  {countdownLabel(nextStarted ? nextEvent.endsAt : nextEvent.startsAt, now)}
                </div>
                <div className="cmd-next__what">
                  {nextEvent.title} · {timeLabel(nextEvent.startsAt, locale)}
                  {ampm(nextEvent.startsAt, locale)}
                </div>
              </div>
            ) : null}

            {hasStatSignal ? (
              <div className="cmd-glance">
                <div className="cmd-glance__title">At a glance</div>
                <div className="cmd-glance__grid">
                  <StatTile
                    label="Priorities"
                    value={priorities.length}
                    icon={<Target size={12} />}
                    onClick={() => navigate("/tasks?focus=priorities")}
                  />
                  <StatTile
                    label="At risk"
                    value={atRisk.length}
                    warn={atRisk.length > 0}
                    icon={<Clock size={12} />}
                    onClick={() => navigate("/tasks?focus=atrisk")}
                  />
                  <StatTile
                    label="Events"
                    value={todayEvents.length}
                    icon={<CalendarDays size={12} />}
                    onClick={() => navigate("/calendar")}
                  />
                  <StatTile
                    label="Done today"
                    value={doneToday}
                    icon={<CheckCircle2 size={12} />}
                    onClick={() => navigate("/tasks?focus=donetoday")}
                  />
                </div>
              </div>
            ) : null}

            <Card title="Today's agenda" meta={`${upcoming.length} left`} padding="sm">
              {upcoming.length > 0 ? (
                <div>
                  {upcoming.map((event, index) => (
                    <AgendaRow
                      key={event.id}
                      time={timeLabel(event.startsAt, locale)}
                      title={event.title}
                      location={event.location}
                      status={index === 0 ? "now" : "default"}
                    />
                  ))}
                </div>
              ) : (
                <div className="agenda-clear">
                  Nothing left on the calendar today. <b>Enjoy the evening.</b>
                </div>
              )}
            </Card>

            {eveningDefinition?.enabled && todayMode === "day" ? (
              <EveningReviewSection
                kind="compact"
                run={latestEveningRun}
                loading={eveningRunsQuery.isPending}
                locale={locale}
                targetTime={targetTimeFor(eveningDefinition, "evening")}
                onFeedbackChanged={() =>
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.briefings.runs(eveningDefinition.id)
                  })
                }
              />
            ) : null}

            {eveningDefinition?.enabled && todayMode === "evening" ? (
              <EveningPrepCard
                interviewPending={eveningInterviewMutation.isPending}
                onPrep={() => {
                  // #891: open the drawer immediately (like the topbar chat button and
                  // openChatWith) rather than waiting for the seed POST to resolve.
                  // Previously openChat lived in the mutation's onSuccess, so a slow or
                  // failing /api/chat/evening-interview left the button doing nothing —
                  // the drawer never opened. The seeded turn streams into the now-open
                  // drawer via the global chat SSE stream.
                  chatControls.openChat();
                  eveningInterviewMutation.mutate();
                }}
              />
            ) : null}

            {wellnessEnabled ? (
              <div className="well">
                <div className="well__head">
                  <span className="ic">
                    <HeartPulse size={15} aria-hidden="true" />
                  </span>
                  <span className="well__title">Wellness</span>
                </div>
                {medTotal > 0 ? (
                  <div className="well__line">
                    {medsAllTaken ? (
                      <>
                        <Check size={14} aria-hidden="true" /> <b>All meds taken</b> today.
                      </>
                    ) : medsNoneLogged ? (
                      <>
                        No meds logged yet today — <b>{medTotal}</b> to go.
                      </>
                    ) : (
                      <>
                        <b>
                          {medTaken} of {medTotal}
                        </b>{" "}
                        meds logged today.
                      </>
                    )}
                  </div>
                ) : null}
                <div className="well__actions">
                  <button
                    className="well__btn well__btn--meds"
                    onClick={() => setMedsModalOpen(true)}
                  >
                    <span className="lead">
                      <span className="ic">
                        <Pill size={15} aria-hidden="true" />
                      </span>
                      Meds
                    </span>
                    {medTotal > 0 ? (
                      <span className={`well__ct${medsAllTaken ? " is-done" : ""}`}>
                        {medTaken}/{medTotal}
                      </span>
                    ) : null}
                  </button>
                  <button className="well__btn" onClick={() => setCheckinModalOpen(true)}>
                    <span className="ic">
                      <ClipboardCheck size={15} aria-hidden="true" />
                    </span>
                    Check in
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>
      {wellnessEnabled && medsModalOpen ? (
        <div
          className="wl-modal-scrim"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setMedsModalOpen(false);
          }}
        >
          <div
            className="wl-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="today-meds-title"
            style={{ maxWidth: 480 }}
          >
            <div className="wl-modal__head">
              <div className="hm">
                <div className="wl-modal__eyebrow">Today</div>
                <div className="wl-modal__title" id="today-meds-title">
                  Medications
                </div>
              </div>
              <button
                type="button"
                className="wl-modal__x"
                aria-label="Close"
                onClick={() => setMedsModalOpen(false)}
              >
                <XIcon />
              </button>
            </div>
            <div className="wl-modal__body" style={{ padding: "0 0 8px" }}>
              <MedToday
                theme={theme}
                onManage={() => {
                  setMedsModalOpen(false);
                  setManageMedsOpen(true);
                }}
                timeZone={locale.timezone}
              />
            </div>
            <div className="wl-modal__foot">
              <span className="spacer" />
              <button
                type="button"
                className="primary-button"
                onClick={() => setMedsModalOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {wellnessEnabled ? (
        <ManageMedsModal
          open={manageMedsOpen}
          onClose={() => setManageMedsOpen(false)}
          theme={theme}
        />
      ) : null}

      {wellnessEnabled ? (
        <CheckinModal
          open={checkinModalOpen}
          onClose={() => setCheckinModalOpen(false)}
          onSave={(val) => createCheckinMutation.mutate(val)}
          initial={null}
          seedEmotion={null}
          theme={theme}
        />
      ) : null}

      {dialog ? (
        <TaskDetailsDialog
          open
          taskId={dialog.id}
          currentUserLabel="You"
          lists={lists}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function MorningBriefingSection(props: {
  readonly run: BriefingRunDto | null;
  readonly loading: boolean;
}) {
  const freshness = props.run ? parseBriefingFreshness(props.run.sourceMetadata) : null;
  const hasSummary = Boolean(props.run?.summaryText.trim());

  return (
    <section className="jds-brief">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Morning briefing</span>
      </div>
      <div className="jds-brief__title">Your day, in focus</div>
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {props.loading ? (
        <div className="agenda-clear">Gathering your morning briefing…</div>
      ) : hasSummary ? (
        <BriefingProse summaryText={props.run?.summaryText ?? ""} />
      ) : (
        <div className="agenda-clear">Your morning briefing is not ready yet.</div>
      )}
    </section>
  );
}

function XIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
