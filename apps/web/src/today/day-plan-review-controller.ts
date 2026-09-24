import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ApplyExecutionItemReport,
  ApplyExecutionReport,
  DayPlanBlockDto,
  DayPlanDto,
  PreviewDayPlanResponse
} from "@moss/shared";

import {
  ApiError,
  applyDayPlan,
  confirmDayPlanApply,
  previewDayPlan,
  retryDayPlanOperation,
  saveDayPlanDraft
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import {
  acceptAllSelectionFor,
  changedBlockIds,
  defaultChoiceFor,
  draftBlocksFor,
  isConfirmationRequired,
  previewSelectionFor,
  retryableOutcomes,
  selectionKey,
  type BlockChoice,
  type PendingApproval,
  type ReviewPlacement
} from "./day-plan-review-model.js";
import { ACCEPT_ALL_NEEDS_REVIEW } from "./today-labels.js";

export interface DayPlanReviewInput {
  readonly plan: DayPlanDto | null;
  readonly localDay: string;
  readonly timeZone: string;
  readonly morningDefinitionId: string | null;
}

export function useDayPlanReview(input: DayPlanReviewInput) {
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Readonly<Record<string, BlockChoice>>>({});
  const [touchedIds, setTouchedIds] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(input.plan?.revision ?? 0);
  const [changedIds, setChangedIds] = useState<readonly string[]>([]);
  const [stalePreview, setStalePreview] = useState(false);
  const [preview, setPreview] = useState<PreviewDayPlanResponse | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, ApplyExecutionItemReport>>>({});
  const [operationId, setOperationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const snapshotRef = useRef<DayPlanDto | null>(input.plan);
  const quietRef = useRef(false);
  const previewRef = useRef<PreviewDayPlanResponse | null>(null);
  const approvalRef = useRef<PendingApproval | null>(null);
  const revisionRef = useRef(input.plan?.revision ?? 0);

  useEffect(() => {
    const next = input.plan;
    if (!next || next.revision === snapshotRef.current?.revision) return;
    const before = snapshotRef.current;
    snapshotRef.current = next;
    revisionRef.current = next.revision;
    setRevision(next.revision);
    if (before === null || quietRef.current) {
      quietRef.current = false;
      return;
    }
    setChangedIds(before ? changedBlockIds(before, next) : []);
    setStalePreview(true);
    setPreview(null);
    previewRef.current = null;
    setApproval(null);
    approvalRef.current = null;
    setNotice("The saved plan changed since it was read. Choices kept; preview again.");
  }, [input.plan]);

  const invalidateAfterWrite = useCallback(() => {
    quietRef.current = true;
    const keys: Array<readonly unknown[]> = [
      queryKeys.calendar.dayPlan(input.localDay, input.timeZone),
      queryKeys.calendar.list,
      queryKeys.tasks.list
    ];
    if (input.morningDefinitionId !== null)
      keys.push(queryKeys.briefings.runs(input.morningDefinitionId));
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
  }, [input.localDay, input.timeZone, input.morningDefinitionId, queryClient]);

  const reloadAfterConflict = useCallback(() => {
    quietRef.current = false;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.calendar.dayPlan(input.localDay, input.timeZone)
    });
  }, [input.localDay, input.timeZone, queryClient]);

  const attempt = useCallback(
    async <T>(work: () => Promise<T>, failedNotice: string): Promise<T | null> => {
      setBusy(true);
      try {
        return await work();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) reloadAfterConflict();
        else setNotice(error instanceof Error ? error.message : failedNotice);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reloadAfterConflict]
  );

  const choiceFor = (block: DayPlanBlockDto): BlockChoice =>
    choices[block.id] ?? defaultChoiceFor(block);

  const touch = useCallback((blockId: string) => {
    setTouchedIds((prev) => (prev.includes(blockId) ? prev : [...prev, blockId]));
  }, []);

  const setPlacement = useCallback(
    (blockId: string, placement: ReviewPlacement, fallbackStartsAt: string | null = null) => {
      setChoices((prev) => {
        const current = prev[blockId];
        const startsAt =
          placement === "add" || placement === "move"
            ? (current?.startsAt ?? fallbackStartsAt)
            : null;
        return { ...prev, [blockId]: { placement, startsAt } };
      });
      setStalePreview(true);
      // A changed selection after a 202 starts over with a new apply.
      setApproval(null);
      setNotice(null);
      touch(blockId);
    },
    [touch]
  );

  const dismissApproval = useCallback(() => {
    approvalRef.current = null;
    setApproval(null);
  }, []);

  const setTime = useCallback(
    (blockId: string, startsAt: string | null) => {
      setChoices((prev) => {
        const current = prev[blockId] ?? { placement: "add" as const, startsAt: null };
        return { ...prev, [blockId]: { ...current, startsAt } };
      });
      setStalePreview(true);
      setApproval(null);
      setNotice(null);
      touch(blockId);
    },
    [touch]
  );

  const storeReport = useCallback((report: ApplyExecutionReport, selection: readonly string[]) => {
    if (report.status === "denied" && report.denialReason)
      setNotice(`The calendar refused the batch: ${report.denialReason}`);
    setOperationId(report.operationId);
    const next: Record<string, ApplyExecutionItemReport> = {};
    for (const item of report.items) {
      const key = item.blockId ?? item.itemId;
      if (key !== null && selection.includes(key)) next[key] = item;
    }
    setOutcomes((prev) => ({ ...prev, ...next }));
    // Applied rows match the saved state now; their choice is spent.
    setChoices((prev) => {
      const kept = { ...prev };
      for (const [key, item] of Object.entries(next)) {
        if (item.outcome === "applied") delete kept[key];
      }
      return kept;
    });
  }, []);

  const runPreview = useCallback(
    async (explicitSelection?: readonly string[]): Promise<boolean> => {
      const plan = snapshotRef.current;
      if (!plan) return false;
      return (
        (await attempt(async () => {
          const saved = await saveDayPlanDraft(plan.id, {
            date: plan.localDay,
            timeZone: plan.timeZone,
            expectedRevision: revision,
            blocks: draftBlocksFor(plan, choiceFor)
          });
          snapshotRef.current = saved.plan;
          revisionRef.current = saved.plan.revision;
          setRevision(saved.plan.revision);
          setChangedIds([]);
          invalidateAfterWrite();
          const selected =
            explicitSelection ?? previewSelectionFor(saved.plan, choiceFor, touchedIds);
          if (selected.length === 0) {
            setPreview(null);
            previewRef.current = null;
            setNotice("No changes to preview yet.");
            return false;
          }
          const response = await previewDayPlan(plan.id, {
            expectedRevision: saved.plan.revision,
            selectedChangeBlockIds: [...selected]
          });
          setPreview(response);
          previewRef.current = response;
          setStalePreview(false);
          revisionRef.current = response.revision;
          setRevision(response.revision);
          return true;
        }, "Preview failed.")) ?? false
      );
    },
    [attempt, choiceFor, invalidateAfterWrite, revision, touchedIds]
  );

  const apply = useCallback(
    async (blockIds: readonly string[]): Promise<boolean> => {
      const plan = snapshotRef.current;
      if (!plan || blockIds.length === 0) return false;
      return (
        (await attempt(async () => {
          const key = selectionKey(plan.id, revisionRef.current, [...blockIds].sort().join(","));
          const response = await applyDayPlan(plan.id, {
            expectedRevision: revisionRef.current,
            idempotencyKey: key,
            selectedBlockIds: [...blockIds]
          });
          if (isConfirmationRequired(response)) {
            approvalRef.current = {
              operationId: response.operationId,
              approvalId: response.approvalId,
              changes: response.changes,
              selection: [...blockIds],
              idempotencyKey: key
            };
            setApproval(approvalRef.current);
            setOperationId(response.operationId);
            return true;
          }
          approvalRef.current = null;
          setApproval(null);
          storeReport(response, blockIds);
          invalidateAfterWrite();
          return true;
        }, "Apply failed.")) ?? false
      );
    },
    [attempt, invalidateAfterWrite, storeReport]
  );

  const confirm = useCallback(async (): Promise<boolean> => {
    const plan = snapshotRef.current;
    if (!plan || !approval) return false;
    return (
      (await attempt(async () => {
        try {
          const report = await confirmDayPlanApply(plan.id, approval.operationId, {
            approvalId: approval.approvalId
          });
          setApproval(null);
          storeReport(report, approval.selection);
          invalidateAfterWrite();
          return true;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
          // The approval is stale: preview again and ask, never retry blindly.
          setApproval(null);
          await runPreview();
          setNotice("The confirmation expired. Preview again, then confirm.");
          return false;
        }
      }, "Confirm failed.")) ?? false
    );
  }, [approval, attempt, invalidateAfterWrite, runPreview, storeReport]);

  const saveChanges = useCallback(async (): Promise<boolean> => {
    const plan = snapshotRef.current;
    if (!plan) return false;
    const selected = previewSelectionFor(plan, choiceFor, touchedIds);
    if (selected.length === 0) return false;
    if (!(await runPreview(selected))) return false;
    const response = previewRef.current;
    if (!response) return false;
    const conflicted = new Set(response.conflicts.map((conflict) => conflict.blockId));
    const list = response.eligibleBlockIds.filter((id) => !conflicted.has(id));
    if (list.length === 0) return false;
    return apply(list);
  }, [apply, choiceFor, runPreview, touchedIds]);

  const acceptAllAdditions = useCallback(async (): Promise<boolean> => {
    const plan = snapshotRef.current;
    if (!plan) return false;
    const selected = acceptAllSelectionFor(plan, choiceFor, touchedIds);
    if (selected.length === 0 || !(await runPreview(selected))) return false;
    const response = previewRef.current;
    if (!response) return false;
    const conflicted = new Set(response.conflicts.map((conflict) => conflict.blockId));
    const list = response.eligibleBlockIds.filter((id) => !conflicted.has(id));
    const applied = await apply(list);
    // A 202 stages nothing usable for additions: drop it and ask for review.
    if (approvalRef.current) {
      dismissApproval();
      setNotice(ACCEPT_ALL_NEEDS_REVIEW);
      return true;
    }
    return applied;
  }, [apply, choiceFor, dismissApproval, runPreview, touchedIds]);

  const retry = useCallback(async (): Promise<boolean> => {
    const plan = snapshotRef.current;
    if (!plan || !operationId) return false;
    const { keys, ids } = retryableOutcomes(outcomes);
    if (ids.length === 0) return false;
    return (
      (await attempt(async () => {
        const report = await retryDayPlanOperation(plan.id, operationId, { itemIds: ids });
        storeReport(report, keys);
        invalidateAfterWrite();
        return true;
      }, "Retry failed.")) ?? false
    );
  }, [attempt, invalidateAfterWrite, operationId, outcomes, storeReport]);

  return {
    choices,
    touchedIds,
    revision,
    changedIds,
    stalePreview,
    preview,
    approval,
    outcomes,
    notice,
    busy,
    choiceFor,
    setPlacement,
    dismissApproval,
    setTime,
    runPreview,
    saveChanges,
    acceptAllAdditions,
    apply,
    confirm,
    retry
  };
}

export type DayPlanReviewController = ReturnType<typeof useDayPlanReview>;
