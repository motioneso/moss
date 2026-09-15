import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { CalendarEventDto, DayPlanDto, DayPlanIntentCapacity, TaskDto } from "@moss/shared";

import {
  ApiError,
  createDayPlan,
  getCalendarBriefingSettings,
  saveDayPlanDraft,
  updateTask
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import {
  acceptAllSelectionFor,
  draftBlocksFor,
  effectivePending,
  localTimeToIso
} from "./day-plan-review-model.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import {
  commitmentRowsFor,
  eveningIntentPatchFor,
  proposeTomorrowBlocks,
  saveStatusLine,
  type CommitmentDecision
} from "./evening-planning-model.js";

export interface EveningPlanningInput {
  readonly active: boolean;
  readonly tomorrowKey: string;
  readonly todayKey: string;
  readonly timeZone: string;
  readonly queryPlan: DayPlanDto | null;
  readonly planMissing: boolean;
  readonly todayPlan: DayPlanDto | null;
  readonly tasks: readonly TaskDto[];
  readonly unavailableTaskIds: readonly string[];
  readonly tomorrowEvents: readonly CalendarEventDto[];
  readonly getReview: () => DayPlanReviewController | null;
}

const DENIED_PREFIX = "The calendar refused the batch: ";

export function useEveningPlanning(input: EveningPlanningInput) {
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<DayPlanDto | null>(input.queryPlan);
  const [corrections, setCorrections] = useState<{ taskId: string; note: string }[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Readonly<Record<string, string>>>({});
  const [decisions, setDecisions] = useState<
    Readonly<Record<string, { decision: Exclude<CommitmentDecision, null>; date: string }>>
  >({});
  const [dueWritten, setDueWritten] = useState<readonly string[]>([]);
  const [capacity, setCapacity] = useState<DayPlanIntentCapacity | null>(null);
  const [priority, setPriority] = useState<readonly string[] | null>(null);
  const [startTime, setStartTime] = useState("09:00");
  const [notesText, setNotesText] = useState<string | null>(null);
  const [policyMode, setPolicyMode] = useState<"off" | "suggest" | "auto">("suggest");
  const [saved, setSaved] = useState(false);
  const [pendingSave, setPendingSave] = useState<{
    moves: readonly string[];
    auto: boolean;
  } | null>(null);
  const [activationIds, setActivationIds] = useState<readonly string[]>([]);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (input.queryPlan && (!plan || input.queryPlan.revision >= plan.revision))
      setPlan(input.queryPlan);
  }, [input.queryPlan, plan]);

  useEffect(() => {
    if (!input.active) return;
    void getCalendarBriefingSettings().then(
      (settings) => setPolicyMode(settings.settings.timeBlockMode),
      () => undefined
    );
  }, [input.active]);

  const rows = commitmentRowsFor(
    input.todayPlan,
    plan,
    input.tasks,
    input.unavailableTaskIds,
    input.tomorrowKey,
    input.timeZone
  );

  const activeCapacity = capacity ?? plan?.eveningIntent?.capacity ?? "normal";
  const activePriority = priority ?? plan?.eveningIntent?.priorityTaskIds ?? [];
  const activeNotes = notesText ?? plan?.eveningIntent?.notes ?? "";

  const committed = new Set<string>();
  for (const row of rows) {
    if (row.marked === null && (decisions[row.task.id]?.decision ?? row.decided) === "tomorrow")
      committed.add(row.task.id);
  }
  const regenerated = proposeTomorrowBlocks(
    plan?.blocks ?? [],
    [...committed],
    activePriority,
    activeCapacity,
    startTime,
    input.tasks,
    input.tomorrowEvents,
    input.tomorrowKey,
    input.timeZone
  );
  const proposals = regenerated.filter((block) => block.id === undefined);

  // The review resyncs after the draft save before its apply can run.
  useEffect(() => {
    if (!pendingSave || !plan) return;
    const review = input.getReview();
    if (!review || review.revision !== plan.revision) return;
    const pending = pendingSave;
    setPendingSave(null);
    void (async () => {
      if (pending.moves.length > 0) await review.apply(pending.moves);
      else if (pending.auto) await review.acceptAllAdditions();
    })();
  }, [pendingSave, plan, input]);

  async function save(): Promise<boolean> {
    const review = input.getReview();
    if (!review || busy) return false;
    setBusy(true);
    setStatusOverride(null);
    try {
      let current = plan;
      if (!current && !input.planMissing) return false;
      current ??= (await createDayPlan({ date: input.tomorrowKey, timeZone: input.timeZone })).plan;
      const mode = await getCalendarBriefingSettings()
        .then((settings) => settings.settings.timeBlockMode)
        .catch(() => policyMode);
      setPolicyMode(mode);
      const patch = eveningIntentPatchFor(current.eveningIntent ?? null, {
        corrections,
        commitments: Object.entries(decisions)
          .map(([taskId, entry]) => ({ taskId, decision: entry.decision }))
          .filter(
            (entry) => entry.decision !== "another-date" || dueWritten.includes(entry.taskId)
          ),
        capacity,
        priorityTaskIds: priority,
        notes: notesText === null || notesText.trim() === "" ? null : notesText.trim()
      });
      // Full replacement: saved proposals yield to fresh ones; only placed blocks and saved moves and removals survive.
      const kept = new Set(regenerated.flatMap((row) => (row.id === undefined ? [] : [row.id])));
      const keptRows = draftBlocksFor(current, review.choiceFor).filter((row) => kept.has(row.id));
      const saved = await saveDayPlanDraft(current.id, {
        date: input.tomorrowKey,
        timeZone: input.timeZone,
        expectedRevision: current.revision,
        eveningIntent: patch,
        blocks: [...keptRows, ...proposals]
      });
      setPlan(saved.plan);
      setSaved(true);
      for (const key of [
        queryKeys.calendar.dayPlan(input.tomorrowKey, input.timeZone),
        queryKeys.calendar.dayPlan(input.todayKey, input.timeZone),
        queryKeys.calendar.list
      ])
        void queryClient.invalidateQueries({ queryKey: key });
      const moves = saved.plan.blocks.flatMap((block) => {
        const effective = effectivePending(block, review.choiceFor(block));
        const kind = effective === undefined ? block.pendingChange?.kind : effective?.kind;
        return kind === "move" || kind === "remove" ? [block.id] : [];
      });
      // Per-activation ids only, so earlier applies never leak in (invariant 6b); moves and removals count with additions.
      const additions = acceptAllSelectionFor(saved.plan, review.choiceFor, review.touchedIds);
      setActivationIds([...additions, ...moves]);
      setPendingSave(moves.length > 0 || mode === "auto" ? { moves, auto: mode === "auto" } : null);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.calendar.dayPlan(input.tomorrowKey, input.timeZone)
        });
        setStatusOverride("The saved plan changed since it was read. Choices kept; save again.");
      } else {
        setStatusOverride("Save failed. Check the connection and try again.");
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmSave(): Promise<boolean> {
    const review = input.getReview();
    if (!review) return false;
    const ok = await review.confirm();
    if (!ok) {
      setStatusOverride("The confirmation expired. Review the changes and save again.");
      return false;
    }
    if (policyMode === "auto") await review.acceptAllAdditions();
    return true;
  }

  function cancelConfirm(): void {
    input.getReview()?.dismissApproval();
    setStatusOverride("Saved draft kept. The calendar is unchanged.");
  }

  async function changeDueDate(taskId: string): Promise<boolean> {
    const date = decisions[taskId]?.date ?? "";
    if (date === "") return false;
    const zoned = localTimeToIso(date, "00:00", input.timeZone);
    if (zoned === null) {
      setStatusOverride("Pick a valid date first.");
      return false;
    }
    setBusy(true);
    try {
      await updateTask(taskId, { dueAt: zoned });
      setDueWritten((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]));
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
      return true;
    } catch {
      setStatusOverride("The due date did not save. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const review = input.getReview();
  const counts = { applied: 0, failed: 0, pending: 0 };
  const activation = new Set(activationIds);
  for (const [blockId, item] of Object.entries(review?.outcomes ?? {})) {
    if (!activation.has(blockId)) continue;
    if (item.outcome === "applied") counts.applied += 1;
    else if (item.outcome === "failed") counts.failed += 1;
    else counts.pending += 1;
  }
  const reviewNotice = review?.notice ?? null;
  const deniedReason =
    reviewNotice !== null && reviewNotice.startsWith(DENIED_PREFIX)
      ? reviewNotice.slice(DENIED_PREFIX.length)
      : null;

  return {
    plan,
    rows,
    corrections,
    noteDrafts,
    decisions,
    activeCapacity,
    activePriority,
    startTime,
    activeNotes,
    reviewNotice,
    status:
      statusOverride ??
      saveStatusLine({
        mode: policyMode,
        saved,
        applied: counts.applied,
        failed: counts.failed,
        pending: counts.pending,
        deniedReason,
        needsConfirm: review?.approval != null
      }),
    busy,
    proposals,
    setNote: (taskId: string, note: string) =>
      setNoteDrafts((prev) => ({ ...prev, [taskId]: note })),
    addCorrectionFor: (taskId: string) => {
      const note = (noteDrafts[taskId] ?? "").trim();
      if (note === "") return;
      setCorrections((current) => [...current, { taskId, note }]);
      setNoteDrafts((prev) => ({ ...prev, [taskId]: "" }));
    },
    setDecision: (taskId: string, decision: Exclude<CommitmentDecision, null>) =>
      setDecisions((prev) => ({ ...prev, [taskId]: { decision, date: prev[taskId]?.date ?? "" } })),
    clearDecision: (taskId: string) =>
      setDecisions((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([id]) => id !== taskId))
      ),
    setDateFor: (taskId: string, date: string) =>
      setDecisions((prev) => ({
        ...prev,
        [taskId]: { decision: prev[taskId]?.decision ?? "another-date", date }
      })),
    changeDueDate,
    setCapacity,
    setPriority,
    setStartTime,
    setNotesText,
    save,
    confirmSave,
    cancelConfirm
  };
}

export type EveningPlanningController = ReturnType<typeof useEveningPlanning>;
