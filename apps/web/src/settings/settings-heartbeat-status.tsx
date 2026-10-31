import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@moss/ui";
import type { HeartbeatOutcomeKind } from "@moss/shared";

import { deleteScheduledTask, listScheduledTasks } from "../api/client.js";
import {
  deleteHeartbeatMute,
  getHeartbeatStatus,
  listHeartbeatMutes
} from "../api/client-heartbeat.js";
import { queryKeys } from "../api/query-keys.js";
import { useUserLocale } from "../locale/locale-format.js";
import { isPastTask } from "./scheduled-task-details/types.js";
import { Group, Note, Row, formatTimestamp } from "./settings-ui.js";

const OUTCOME_LABELS: Record<HeartbeatOutcomeKind, string> = {
  never: "Never checked",
  off: "Off",
  quiet: "Quiet",
  message: "Sent a message",
  held_allowance: "Held for the daily limit",
  degraded: "Checked with some sources unavailable",
  failed: "Failed"
};

export function HeartbeatStatusGroup() {
  const locale = useUserLocale();
  const status = useQuery({
    queryKey: queryKeys.heartbeat.status,
    queryFn: getHeartbeatStatus,
    retry: false
  });
  const latest = status.data?.status;
  return (
    <Group title="Check-in status" titleAs="h3">
      {status.isPending ? <p role="status">Loading…</p> : null}
      {status.isError ? (
        <Note>
          Could not load check-in status.{" "}
          <Button variant="link" size="sm" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </Note>
      ) : null}
      {latest ? (
        <Row
          name="Last check"
          desc={
            latest.lastCheckedAt
              ? formatTimestamp(latest.lastCheckedAt, latest.lastCheckedAt, locale)
              : "No check has run yet."
          }
          control={<span>{OUTCOME_LABELS[latest.outcome]}</span>}
        />
      ) : null}
    </Group>
  );
}

export function HeartbeatMutesGroup() {
  const queryClient = useQueryClient();
  const mutes = useQuery({
    queryKey: queryKeys.heartbeat.mutes,
    queryFn: listHeartbeatMutes,
    retry: false
  });
  const remove = useMutation({
    mutationFn: deleteHeartbeatMute,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.heartbeat.mutes })
  });
  return (
    <Group title="Muted topics" titleAs="h3">
      {mutes.isPending ? <p role="status">Loading…</p> : null}
      {mutes.isError ? (
        <Note>
          Could not load muted topics.{" "}
          <Button variant="link" size="sm" onClick={() => void mutes.refetch()}>
            Try again
          </Button>
        </Note>
      ) : null}
      {mutes.data && mutes.data.mutes.length === 0 ? (
        <p className="set-row__desc">Nothing is muted.</p>
      ) : null}
      {mutes.data?.mutes.map((mute) => (
        <Row
          key={mute.id}
          name={mute.label}
          control={
            <Button
              variant="quiet"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate(mute.id)}
            >
              Remove
            </Button>
          }
        />
      ))}
      {remove.isError ? <Note>Could not remove that topic. Try again.</Note> : null}
    </Group>
  );
}

export function HeartbeatJobsGroup() {
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: queryKeys.chat.scheduledTasks,
    queryFn: listScheduledTasks,
    retry: false
  });
  const stop = useMutation({
    mutationFn: deleteScheduledTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat.scheduledTasks })
  });
  const active = jobs.data?.tasks.filter((task) => !isPastTask(task)) ?? [];
  return (
    <Group title="Scheduled jobs" titleAs="h3">
      {jobs.isPending ? <p role="status">Loading…</p> : null}
      {jobs.isError ? (
        <Note>
          Could not load scheduled jobs.{" "}
          <Button variant="link" size="sm" onClick={() => void jobs.refetch()}>
            Try again
          </Button>
        </Note>
      ) : null}
      {jobs.data && active.length === 0 ? (
        <p className="set-row__desc">No scheduled jobs.</p>
      ) : null}
      {active.map((task) => (
        <Row
          key={task.id}
          name={task.title}
          desc={task.group}
          control={
            <Button
              variant="quiet"
              size="sm"
              disabled={stop.isPending}
              onClick={() => stop.mutate(task.id)}
            >
              Stop
            </Button>
          }
        />
      ))}
      {stop.isError ? <Note>Could not stop that job. Try again.</Note> : null}
    </Group>
  );
}
