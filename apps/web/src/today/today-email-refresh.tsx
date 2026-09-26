import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  EmailRefreshStatusResponse,
  RequestEmailRefreshResponse,
  SourceFreshnessV1
} from "@moss/shared";

import { Button } from "@moss/ui";

import { getBriefingRun, requestJson } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const REFRESH_LABEL = "Refresh email";

export function isEmailSourceStale(freshness: SourceFreshnessV1 | null): boolean {
  if (!freshness) return false;
  const email = freshness.sources.find((source) => source.source === "email");
  if (!email || email.freshnessKind === "realtime" || !email.asOf) return false;
  const ageMs = new Date(freshness.capturedAt).getTime() - new Date(email.asOf).getTime();
  return Number.isFinite(ageMs) && ageMs > DAY_MS;
}

function isRefreshComplete(status: EmailRefreshStatusResponse["status"] | undefined): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

export function emailRefreshAllowsBriefing(
  status: EmailRefreshStatusResponse["status"] | undefined
): boolean {
  return status === "succeeded" || status === "partial";
}

/** Today-only recovery action. It preserves the current report and plan on either failure path. */
interface TodayEmailRefreshActionProps {
  readonly definitionId: string;
  readonly freshness: SourceFreshnessV1 | null;
}

export function TodayEmailRefreshAction(props: TodayEmailRefreshActionProps) {
  if (!isEmailSourceStale(props.freshness)) return null;
  return <ActiveTodayEmailRefreshAction {...props} />;
}

function ActiveTodayEmailRefreshAction(props: TodayEmailRefreshActionProps) {
  const queryClient = useQueryClient();
  const [refreshId, setRefreshId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runJobId, setRunJobId] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const startedRunForRefresh = useRef(new Set<string>());
  const invalidatedRunId = useRef<string | null>(null);

  const refreshMutation = useMutation({
    mutationFn: () => {
      requestKey.current ??= globalThis.crypto.randomUUID();
      return requestJson<RequestEmailRefreshResponse>("/api/connectors/email-refresh", {
        method: "POST",
        body: { idempotencyKey: requestKey.current }
      });
    },
    onMutate: () => {
      setRefreshId(null);
      setRunId(null);
      setRunJobId(null);
      invalidatedRunId.current = null;
    },
    onSuccess: (result) => {
      requestKey.current = null;
      setRefreshId(result.refreshId);
    }
  });

  const refreshQuery = useQuery({
    queryKey: ["connectors", "email-refresh", refreshId],
    queryFn: () =>
      requestJson<EmailRefreshStatusResponse>(
        `/api/connectors/email-refresh/${encodeURIComponent(refreshId ?? "")}`
      ),
    enabled: refreshId !== null,
    refetchInterval: (query) =>
      isRefreshComplete(query.state.data?.status) ? false : POLL_INTERVAL_MS
  });

  const runMutation = useMutation({
    mutationFn: (completedRefreshId: string) =>
      requestJson<{ readonly jobId: string; readonly runId: string }>(
        `/api/briefings/definitions/${encodeURIComponent(props.definitionId)}/run`,
        { method: "POST", body: { idempotencyKey: completedRefreshId } }
      ),
    onSuccess: (result) => {
      setRunJobId(result.jobId);
      setRunId(result.runId);
    }
  });

  const refreshStatus = refreshQuery.data?.status;
  useEffect(() => {
    if (
      !refreshId ||
      !emailRefreshAllowsBriefing(refreshStatus) ||
      startedRunForRefresh.current.has(refreshId)
    )
      return;

    startedRunForRefresh.current.add(refreshId);
    runMutation.mutate(refreshId);
  }, [refreshId, refreshStatus, runMutation.mutate]);

  const runQuery = useQuery({
    queryKey: queryKeys.briefings.run(props.definitionId, runId ?? ""),
    queryFn: () => getBriefingRun(props.definitionId, runId ?? "", runJobId ?? undefined),
    enabled: runId !== null && runJobId !== null,
    refetchInterval: (query) =>
      query.state.error || (query.state.data && query.state.data.state !== "pending")
        ? false
        : POLL_INTERVAL_MS
  });

  useEffect(() => {
    if (
      runId &&
      runQuery.data?.state === "ready" &&
      runQuery.data.run?.status === "succeeded" &&
      invalidatedRunId.current !== runId
    ) {
      invalidatedRunId.current = runId;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.briefings.runs(props.definitionId)
      });
    }
  }, [props.definitionId, queryClient, runId, runQuery.data?.state]);

  const refreshPending =
    refreshMutation.isPending ||
    (refreshId !== null &&
      (!refreshQuery.data || refreshStatus === "queued" || refreshStatus === "running"));
  const runPending =
    (refreshStatus === "succeeded" || refreshStatus === "partial") &&
    (runMutation.isPending ||
      (runId !== null &&
        !runQuery.isError &&
        (!runQuery.data || runQuery.data.state === "pending")));
  const busy = refreshPending || runPending;

  let message: string | null = null;
  if (refreshMutation.isError) {
    message =
      "Moss couldn’t start an email refresh. Your current report and plan choices are still available.";
  } else if (refreshStatus === "failed") {
    message =
      "Email couldn’t be refreshed. Your current report and plan choices are still available.";
  } else if (refreshPending) {
    message = refreshQuery.isError ? "Checking whether email has finished…" : "Refreshing email…";
  } else if (runMutation.isError) {
    message =
      "Email refreshed, but Moss couldn’t prepare an updated briefing. Your current report and plan choices are still available.";
  } else if (runPending) {
    message = "Email refreshed. Preparing an updated briefing…";
  } else if (runQuery.data?.state === "failed" || runQuery.isError) {
    message =
      "Email refreshed, but Moss couldn’t prepare an updated briefing. Your current report and plan choices are still available.";
  } else if (runQuery.data?.state === "ready" && runQuery.data.run?.status === "succeeded") {
    message =
      refreshStatus === "partial"
        ? "Some email may still be missing. The updated briefing is ready."
        : "Email refreshed. The updated briefing is ready.";
  } else if (runQuery.data?.state === "ready") {
    message =
      "Email refreshed, but Moss couldn’t prepare an updated briefing. Your current report and plan choices are still available.";
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        aria-busy={busy}
        onClick={() => refreshMutation.mutate()}
      >
        {REFRESH_LABEL}
      </Button>
      {message ? <span role="status">{message}</span> : null}
    </>
  );
}
