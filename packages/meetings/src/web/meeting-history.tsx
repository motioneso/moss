import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@moss/module-web-sdk";
import { Button, Field, FormLabel, Select, Badge } from "@moss/ui";
import type { MeetingHistoryCursor } from "@moss/shared";
import { getRecordingTypes, recordingKeys } from "./recording-client.js";
import { isMeetingAccessDenied, PAGE_SIZE } from "./client.js";
import { discardDeniedHistory, historyKeys, searchMeetingHistory } from "./history-client.js";
import { meetingLength } from "./history-presentation.js";
import { useMeetingDate } from "./locale.js";

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
    initialPageParam: undefined as MeetingHistoryCursor | undefined,
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
      {!searching && meetings.length ? (
        <div className="meetings-history-scroll">
          <table className="meetings-history-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Date</th>
                <th scope="col">Length</th>
                <th scope="col">Attendees</th>
                <th scope="col">Type</th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((meeting) => (
                <tr key={meeting.id} className="meetings-history-row">
                  <td>
                    <Button variant="link" onClick={() => onOpen(meeting.id)}>
                      {meeting.title}
                    </Button>
                  </td>
                  <td data-label="Date">
                    <span>{date(meeting.date.at)}</span>
                    <span className="jds-hint meetings-history-date-source">
                      {meeting.date.source === "recorded" ? "Recorded" : "Added"}
                    </span>
                  </td>
                  <td data-label="Length">{meetingLength(meeting.capture.durationMs)}</td>
                  <td data-label="Attendees">—</td>
                  <td data-label="Type">
                    {meeting.recording?.typeId ? (
                      <Badge tone="neutral" pill>
                        {types.data?.types.find((type) => type.id === meeting.recording?.typeId)
                          ?.name ?? meeting.recording.typeId}
                      </Badge>
                    ) : (
                      "—"
                    )}
                    {meeting.recording?.side ? (
                      <span className="jds-hint meetings-history-side">
                        {meeting.recording.side === "personal" ? "Personal" : "Work"}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
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
