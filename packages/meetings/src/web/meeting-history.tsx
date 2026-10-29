import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@moss/module-web-sdk";
import { Button, Divider, Eyebrow, Field, FormLabel, RowButton, Select, Badge } from "@moss/ui";
import type { MeetingHistoryItem, MeetingRecordCursor } from "@moss/shared";
import { getRecordingTypes, recordingKeys } from "./recording-client.js";
import { isMeetingAccessDenied, PAGE_SIZE } from "./client.js";
import { discardDeniedHistory, historyKeys, searchMeetingHistory } from "./history-client.js";
import { useMeetingDate, useMeetingWeek } from "./locale.js";

export interface MeetingHistoryProps {
  readonly search: string;
  readonly hideWhenEmpty?: boolean;
  readonly onSearch: (value: string) => void;
  readonly onOpen: (id: string) => void;
}

/** A calendar-date grouping uses the owner's configured timezone, just like each row. */
export function MeetingHistory({
  search,
  onSearch,
  onOpen,
  hideWhenEmpty = false
}: MeetingHistoryProps) {
  const date = useMeetingDate({
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  const week = useMeetingWeek();
  const client = useQueryClient();
  const [typeId, setTypeId] = useState("");
  const types = useQuery({
    queryKey: recordingKeys.types,
    queryFn: ({ signal }) => getRecordingTypes(signal),
    retry: false
  });
  const [query, setQuery] = useState(search.trim());
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const history = useInfiniteQuery({
    queryKey: historyKeys.search(query, "all", typeId || undefined),
    initialPageParam: undefined as MeetingRecordCursor | undefined,
    queryFn: ({ pageParam, signal }) =>
      searchMeetingHistory(
        { query, filter: "all", typeId: typeId || undefined, limit: PAGE_SIZE, before: pageParam },
        signal
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always"
  });
  const denied = isMeetingAccessDenied(history.error);
  useEffect(() => {
    if (denied) discardDeniedHistory(client, historyKeys.search(query, "all", typeId || undefined));
  }, [client, denied, query, typeId]);
  const meetings = denied ? [] : (history.data?.pages.flatMap((page) => page.meetings) ?? []);
  const searching = search.trim() !== query;
  const groups = new Map<string, MeetingHistoryItem[]>();
  for (const meeting of meetings) {
    const key = week(meeting.createdAt).label;
    groups.set(key, [...(groups.get(key) ?? []), meeting]);
  }
  if (hideWhenEmpty && history.isSuccess && !meetings.length && !search && !typeId) return null;
  return (
    <section className="meetings-section" aria-label="Your meetings">
      <div className="meetings-history-filters">
        <Field>
          <FormLabel htmlFor="meeting-history-search">Search meetings</FormLabel>
          <input
            id="meeting-history-search"
            type="search"
            className="jds-input meetings-input"
            placeholder="Search titles, notes and transcripts"
            maxLength={256}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </Field>
        <Field>
          <FormLabel htmlFor="meeting-history-type">Recording type</FormLabel>
          <Select
            id="meeting-history-type"
            value={typeId}
            disabled={!types.data || types.isError}
            onChange={(event) => setTypeId(event.target.value)}
          >
            <option value="">All types</option>
            {types.data?.types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {types.isError ? (
        <p role="alert" className="jds-hint">
          Couldn’t load recording types.{" "}
          <Button variant="link" onClick={() => void types.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {history.fetchStatus === "paused" ? (
        <p role="status" className="jds-hint">
          You’re offline. Search will continue when you reconnect.
        </p>
      ) : history.isPending || searching ? (
        <p role="status" className="jds-hint">
          Loading meetings…
        </p>
      ) : null}
      {history.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {denied
            ? "Meetings are unavailable. Sign in again or retry."
            : history.error instanceof ApiError && history.error.status === 400
              ? "Shorten your search and try again."
              : "Couldn’t load meetings."}{" "}
          <Button variant="link" onClick={() => void history.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {history.isSuccess && !meetings.length && !searching ? (
        <p className="jds-hint">
          {query || typeId
            ? "No meetings match this search."
            : "No meetings yet. Start with Add recording or New meeting."}
        </p>
      ) : null}
      {!searching &&
        [...groups].map(([start, items]) => (
          <section key={start} className="meetings-section" aria-label={start}>
            <Eyebrow>{start}</Eyebrow>
            <div>
              {items.map((meeting) => (
                <div key={meeting.id}>
                  <Divider />
                  <RowButton className="meetings-history-row" onClick={() => onOpen(meeting.id)}>
                    <span className="jds-hint">{date(meeting.createdAt)}</span>
                    <span className="meetings-history-heading">
                      <span className="jds-label">{meeting.title}</span>
                      {meeting.recording?.typeId || meeting.recording?.side ? (
                        <span className="meetings-actions">
                          {meeting.recording.typeId ? (
                            <Badge tone="neutral" pill>
                              {types.data?.types.find(
                                (type) => type.id === meeting.recording?.typeId
                              )?.name ?? meeting.recording.typeId}
                            </Badge>
                          ) : null}
                          {meeting.recording.side ? (
                            <span className="jds-hint">
                              {meeting.recording.side === "personal" ? "Personal" : "Work"}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      <span className="jds-hint meetings-history-gist">
                        {meeting.summary.overview ??
                          (meeting.hasNotes
                            ? "Personal notes"
                            : meeting.transcript.segmentCount
                              ? "Transcript available"
                              : "Ready when you are")}
                      </span>
                    </span>
                    <span className="jds-hint">
                      {meeting.capture.durationMs == null
                        ? ""
                        : `${Math.max(1, Math.round(meeting.capture.durationMs / 60000))} min`}
                    </span>
                  </RowButton>
                </div>
              ))}
            </div>
          </section>
        ))}
      {history.hasNextPage && !searching && !denied ? (
        <Button
          variant="secondary"
          disabled={history.isFetchingNextPage || history.fetchStatus === "paused"}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading more…" : "Load older meetings"}
        </Button>
      ) : null}
    </section>
  );
}
