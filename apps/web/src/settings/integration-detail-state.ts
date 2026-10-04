import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { IntegrationDetail } from "@moss/shared";

import {
  getIntegration,
  prepareIntegrationClassifierTools,
  setIntegrationKeptOut,
  setIntegrationSendWithoutAsking,
  sortIntegrationClassifierTools,
  updateIntegration
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import {
  preparationPending,
  withClassifierEnabled,
  withKeptOut,
  withPreparationRetried,
  withSortRetried
} from "./integration-classifier-state";
import { toolsOnPatch } from "./integration-tool-groups";

/** How often an open connection re-reads while tools wait to be sorted or prepared. */
export const SORT_POLL_MS = 3_000;

/**
 * An open page stops waiting after this long, e.g. when no model can sort. Turning the
 * classifier on or pressing Try again starts the wait over.
 */
export const SORT_WATCH_MS = 10 * 60_000;

/** True while the worker still owes a sort for at least one tool. */
export function sortPending(detail: IntegrationDetail | undefined): boolean {
  return (
    detail?.classifierTools.some(
      (tool) => tool.status === "never_tried" || tool.status === "stale"
    ) ?? false
  );
}

/** Marks the named sending tools as allowed or asking, the way the server will. */
export function withSendWithoutAsking(
  detail: IntegrationDetail,
  toolNames: readonly string[],
  allow: boolean
): IntegrationDetail {
  return {
    ...detail,
    classifierTools: detail.classifierTools.map((tool) =>
      toolNames.includes(tool.toolName) && tool.status === "current" && tool.risk === "outbound"
        ? { ...tool, sendWithoutAsking: allow, asksFirst: !allow }
        : tool
    )
  };
}

/**
 * The open connection's detail and the tool changes made on it.
 *
 * Each change applies to the cached detail at once and its request joins one queue. While the
 * queue is busy, a change builds on the previous change rather than the cache, so a server read
 * landing mid-queue cannot feed it stale lists. A request carries the state as it stood after
 * that click, so requests land in click order and the last one holds the newest state. The
 * detail re-reads from the server once the queue drains; a read in flight when a click lands is
 * cancelled so it cannot undo the click on screen.
 *
 * While tools wait to be sorted or prepared the detail re-reads every few seconds, so the
 * groups and the classifier's progress appear without a reload.
 */
export function useIntegrationDetail(id: string, onError: (error: unknown) => void) {
  const queryClient = useQueryClient();
  const key = queryKeys.integrations.detail(id);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);
  const latest = useRef<IntegrationDetail | undefined>(undefined);
  const [changing, setChanging] = useState(false);
  const watchedFrom = useRef(Date.now());

  const detailQuery = useQuery({
    queryKey: key,
    queryFn: () => getIntegration(id),
    retry: false,
    refetchInterval: (query) =>
      !changing &&
      (sortPending(query.state.data) || preparationPending(query.state.data)) &&
      Date.now() - watchedFrom.current < SORT_WATCH_MS
        ? SORT_POLL_MS
        : false
  });

  const change = (
    next: (detail: IntegrationDetail) => IntegrationDetail,
    send: (detail: IntegrationDetail) => Promise<unknown>
  ) => {
    const current =
      queued.current > 0 ? latest.current : queryClient.getQueryData<IntegrationDetail>(key);
    if (!current) return;
    void queryClient.cancelQueries({ queryKey: key });
    const updated = next(current);
    latest.current = updated;
    queryClient.setQueryData(key, updated);
    queued.current += 1;
    setChanging(true);
    queue.current = queue.current
      .then(() => send(updated))
      .then(
        () => undefined,
        (error: unknown) => onError(error)
      )
      .finally(() => {
        queued.current -= 1;
        if (queued.current > 0) return;
        setChanging(false);
        // The list key prefixes the detail key, so this re-reads both.
        void queryClient.invalidateQueries({ queryKey: queryKeys.integrations.list });
      });
  };

  const setToolsOn = (names: readonly string[], on: boolean) =>
    change(
      (detail) => ({ ...detail, ...toolsOnPatch(detail, names, on) }),
      (detail) =>
        updateIntegration(id, { enabledTools: detail.enabledTools, mutedTools: detail.mutedTools })
    );

  const setSendWithoutAsking = (toolNames: readonly string[], allow: boolean) =>
    change(
      (detail) => withSendWithoutAsking(detail, toolNames, allow),
      () => setIntegrationSendWithoutAsking(id, { allow, toolNames: [...toolNames] })
    );

  const setKeptOut = (toolNames: readonly string[], keptOut: boolean) =>
    change(
      (detail) => withKeptOut(detail, toolNames, keptOut),
      () => setIntegrationKeptOut(id, { keptOut, toolNames: [...toolNames] })
    );

  const setClassifierEnabled = (on: boolean) => {
    watchedFrom.current = Date.now();
    change(
      (detail) => withClassifierEnabled(detail, on),
      () => updateIntegration(id, { classifierEnabled: on })
    );
  };

  const retryPreparation = () => {
    watchedFrom.current = Date.now();
    change(withPreparationRetried, () => prepareIntegrationClassifierTools(id, {}));
  };

  const retrySort = () => {
    watchedFrom.current = Date.now();
    change(withSortRetried, () => sortIntegrationClassifierTools(id));
  };

  return {
    detailQuery,
    setToolsOn,
    setSendWithoutAsking,
    setKeptOut,
    setClassifierEnabled,
    retryPreparation,
    retrySort
  };
}
