import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Group, Note, PaneHead, Row, Switch, formatTimestamp } from "@moss/settings-ui";
import type {
  BacktrackDeleteRequest,
  BacktrackDeleteResponse,
  BacktrackPreferencesRequest,
  BacktrackPreferencesResponse,
  BacktrackStatusResponse,
  ListMySessionsResponse
} from "@moss/shared";
import { Button, Dialog, EmptyState } from "@moss/ui";

/**
 * Moss Settings → Backtrack (#2638 plan 2026-10-03-backtrack-phase2.md §4.8). Every message
 * renders from the status record and the signed-in sessions, never from model output.
 * Decision 8: no notes-folder row and no daily-notes checkbox until Phase 4 writes notes.
 */

const STATUS_KEY = ["backtrack", "status"] as const;
const SESSIONS_KEY = ["settings", "sessions"] as const;
const HOUR_MS = 60 * 60 * 1000;

async function requestJson<T>(path: string, init?: RequestInit & { body?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "include",
    headers
  });
  if (!response.ok) throw new Error(response.statusText || "Request failed");
  return (await response.json()) as T;
}

/** [from, to) for one calendar day in the browser's time zone (decision 7). */
export function localDayRange(
  year: number,
  monthIndex: number,
  day: number
): Required<BacktrackDeleteRequest> {
  return {
    from: new Date(year, monthIndex, day).toISOString(),
    to: new Date(year, monthIndex, day + 1).toISOString()
  };
}

export function lastHourRange(now: Date): Required<BacktrackDeleteRequest> {
  return { from: new Date(now.getTime() - HOUR_MS).toISOString(), to: now.toISOString() };
}

export function todayRange(now: Date): Required<BacktrackDeleteRequest> {
  return localDayRange(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Today as a native `type="date"` value, in the browser's time zone: the latest day to offer. */
export function todayDateValue(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Parses a native `type="date"` value (`YYYY-MM-DD`); undefined when it isn't one. */
export function chosenDayRange(value: string): Required<BacktrackDeleteRequest> | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return localDayRange(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

interface DeleteConfirmation {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly range: () => BacktrackDeleteRequest;
}

/** A chosen day for the confirmation title, e.g. "Saturday, October 4". */
function formatDay(fromIso: string): string {
  return new Date(fromIso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function BacktrackSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => requestJson<BacktrackStatusResponse>("/api/backtrack/status")
  });
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => requestJson<ListMySessionsResponse>("/api/me/sessions")
  });
  const pause = useMutation({
    mutationFn: (body: BacktrackPreferencesRequest) =>
      requestJson<BacktrackPreferencesResponse>("/api/backtrack/preferences", {
        method: "PUT",
        body
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY })
  });
  const remove = useMutation({
    mutationFn: (body: BacktrackDeleteRequest) =>
      requestJson<BacktrackDeleteResponse>("/api/backtrack/segments", { method: "DELETE", body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY })
  });
  // Every delete asks first (Ben, 2026-10-04 live proof). The range is worked out when the
  // person confirms, so "Last hour" means the hour before they pressed Delete.
  const [confirming, setConfirming] = useState<DeleteConfirmation | null>(null);
  const [choosingDay, setChoosingDay] = useState(false);
  const [day, setDay] = useState("");

  const head = (
    <PaneHead
      title="Backtrack"
      desc="Your day memory: the text Trail Marker read from your screen, kept in Moss."
    />
  );

  if (status.isLoading) {
    return (
      <>
        {head}
        <Note>Loading Backtrack…</Note>
      </>
    );
  }
  if (status.isError || !status.data) {
    return (
      <>
        {head}
        <Note>Could not load Backtrack. </Note>
        <Button variant="secondary" size="sm" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </>
    );
  }

  const data = status.data;
  const linkedMacs = (sessions.data?.sessions ?? []).filter(
    (session) => session.source === "companion"
  ).length;
  // Sessions are the truth for "a Mac is linked"; if they fail to load, fall back to Macs that
  // have recently uploaded so the screen still renders.
  const macCount = sessions.data ? linkedMacs : data.macs;
  const hasHistory = data.days > 0 || data.bytes > 0;

  const deleteRange = (range: BacktrackDeleteRequest) => remove.mutate(range);

  const deleteGroup = (
    <Group
      title="Delete"
      desc="Deleting is permanent, and it works whether or not a Mac is linked."
    >
      <Row
        className="set-row--stack-narrow"
        name="Delete recent history"
        desc="Removes what Backtrack kept in that time, for you only."
        control={
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                setConfirming({
                  title: "Delete the last hour?",
                  description:
                    "This removes what Backtrack kept from the last hour. It can't be undone.",
                  action: "Delete the last hour",
                  range: () => lastHourRange(new Date())
                })
              }
            >
              Last hour
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                setConfirming({
                  title: "Delete today?",
                  description:
                    "This removes what Backtrack kept since midnight today. It can't be undone.",
                  action: "Delete today",
                  range: () => todayRange(new Date())
                })
              }
            >
              Today
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={remove.isPending}
              onClick={() => setChoosingDay((open) => !open)}
            >
              Choose a day…
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                setConfirming({
                  title: "Delete all of Backtrack?",
                  description: `This removes the ${plural(data.days, "day", "days")} of text Moss has kept. It can't be undone. Backtrack keeps recording from now on unless you turn it off.`,
                  action: "Delete everything",
                  range: () => ({})
                })
              }
            >
              Everything…
            </Button>
          </span>
        }
      />
      {choosingDay ? (
        <Row
          className="set-row--stack-narrow"
          name="Delete one day"
          desc="The day runs from midnight to midnight in this browser's time zone."
          control={
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="date"
                className="jds-input"
                aria-label="Day to delete"
                max={todayDateValue(new Date())}
                value={day}
                onChange={(event) => setDay(event.target.value)}
              />
              <Button
                variant="danger"
                size="sm"
                disabled={remove.isPending || chosenDayRange(day) === undefined}
                onClick={() => {
                  const range = chosenDayRange(day);
                  if (!range) return;
                  setConfirming({
                    title: `Delete ${formatDay(range.from)}?`,
                    description:
                      "This removes what Backtrack kept on that day, midnight to midnight. It can't be undone.",
                    action: "Delete the day",
                    range: () => range
                  });
                }}
              >
                Delete that day
              </Button>
            </span>
          }
        />
      ) : null}
      {remove.isSuccess ? (
        <Note>
          {remove.data.deleted === 0
            ? "Nothing was kept in that time."
            : `Deleted ${plural(remove.data.deleted, "stored segment", "stored segments")}.`}
        </Note>
      ) : null}
      {remove.isError ? <Note>Could not delete. Try again.</Note> : null}
    </Group>
  );

  const confirmDialog = confirming ? (
    <Dialog
      title={<span id="backtrack-delete-confirm-title">{confirming.title}</span>}
      aria-labelledby="backtrack-delete-confirm-title"
      description={confirming.description}
      onClose={() => setConfirming(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setConfirming(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const range = confirming.range();
              setConfirming(null);
              deleteRange(range);
            }}
          >
            {confirming.action}
          </Button>
        </>
      }
    >
      <></>
    </Dialog>
  ) : null;

  if (data.storage === "off") {
    return (
      <>
        {head}
        <Note>Backtrack storage isn't available on this Moss yet. An admin has to turn it on.</Note>
        {hasHistory ? (
          <>
            <Note>Text kept from an earlier time is still stored, and you can delete it here.</Note>
            {deleteGroup}
          </>
        ) : null}
        {confirmDialog}
      </>
    );
  }

  if (macCount === 0 && !hasHistory) {
    return (
      <>
        {head}
        <EmptyState
          title="No Mac is linked"
          description="Link Trail Marker for Mac, then turn Backtrack on in its Settings. Link it from Account settings."
        />
      </>
    );
  }

  return (
    <>
      {head}
      <Group
        title="Recording"
        desc="Turning a Mac's recording on happens on that Mac, with its consent. This switch pauses Backtrack for every Mac."
        action={
          <Badge tone={data.paused ? "amber" : "pine"} dot>
            {data.paused ? "Paused" : `On · ${plural(macCount, "Mac", "Macs")}`}
          </Badge>
        }
      >
        <Row
          name="Recording"
          desc={
            data.paused
              ? "Paused from Moss: nothing new is stored."
              : "Moss stores what your Macs send."
          }
          control={
            <Switch
              ariaLabel="Recording"
              checked={!data.paused}
              disabled={pause.isPending}
              onChange={(value) => pause.mutate({ paused: !value })}
            />
          }
        />
        {macCount === 0 ? (
          <Note>No Mac is linked. Link Trail Marker for Mac to record more.</Note>
        ) : null}
        {pause.isError ? <Note>Could not change recording. Try again.</Note> : null}
      </Group>
      <Group
        title="Kept"
        desc="Backtrack keeps text for 37 days, plus up to one hourly run, then deletes it."
      >
        <Row name="Days kept" control={<span>{plural(data.days, "day", "days")}</span>} />
        <Row name="Stored" control={<span>{formatBytes(data.bytes)}</span>} />
        {data.lastReceivedAt ? (
          <Row
            name="Last received"
            control={<span>{formatTimestamp(data.lastReceivedAt, "Unknown")}</span>}
          />
        ) : null}
      </Group>
      {deleteGroup}
      {confirmDialog}
    </>
  );
}
