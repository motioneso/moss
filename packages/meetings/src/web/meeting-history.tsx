import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, useMeetingChat } from "@moss/module-web-sdk";
import { Button, Divider, EmptyState, Field, FormLabel, SectionHead, Select } from "@moss/ui";
import type { MeetingHistoryFilter, MeetingRecordCursor } from "@moss/shared";
import { isMeetingAccessDenied, PAGE_SIZE } from "./client.js";
import {
  discardDeniedHistory,
  forgetHistoryItem,
  getMeetingHistoryItem,
  historyKeys,
  searchMeetingHistory
} from "./history-client.js";
import {
  historyFilters,
  processingStatus,
  transcriptSpan,
  vaultStatus
} from "./history-presentation.js";
import { MeetingHistoryRail } from "./meeting-history-rail.js";
import { useMeetingDate } from "./locale.js";

export interface MeetingHistoryProps {
  readonly search: string;
  readonly filter: MeetingHistoryFilter;
  readonly selectedId: string | null;
  readonly detailOpen: boolean;
  readonly onSearch: (value: string) => void;
  readonly onFilter: (value: MeetingHistoryFilter) => void;
  readonly onSelect: (id: string) => void;
  readonly onResults: () => void;
  readonly onOpen: (id: string) => void;
  readonly onNew: () => void;
}

export function MeetingHistory(props: MeetingHistoryProps) {
  const { search, filter, selectedId, detailOpen, onOpen, onNew } = props;
  const date = useMeetingDate();
  const client = useQueryClient();
  const { clearMeetingChat } = useMeetingChat();
  const [query, setQuery] = useState(search.trim());
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const history = useInfiniteQuery({
    queryKey: historyKeys.search(query, filter),
    initialPageParam: undefined as MeetingRecordCursor | undefined,
    queryFn: ({ pageParam, signal }) =>
      searchMeetingHistory({ query, filter, limit: PAGE_SIZE, before: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always"
  });
  const historyDenied = isMeetingAccessDenied(history.error);
  const meetings = historyDenied
    ? []
    : (history.data?.pages.flatMap((page) => page.meetings) ?? []);
  const selection = selectedId ?? meetings[0]?.id;
  const detail = useQuery({
    queryKey: historyKeys.item(selection ?? ""),
    queryFn: ({ signal }) => getMeetingHistoryItem(selection!, signal),
    enabled: !!selection && !historyDenied,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: "always"
  });
  const detailDenied = isMeetingAccessDenied(detail.error);
  const lastSelection = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selection && !historyDenied) lastSelection.current = selection;
    const deniedSelection = selection ?? lastSelection.current;
    if (historyDenied) {
      if (deniedSelection) clearMeetingChat(deniedSelection);
      discardDeniedHistory(client, historyKeys.search(query, filter));
    } else if (detailDenied && deniedSelection) {
      clearMeetingChat(deniedSelection);
      forgetHistoryItem(client, deniedSelection);
      void client.invalidateQueries({ queryKey: historyKeys.lists });
    }
  }, [client, clearMeetingChat, detailDenied, filter, historyDenied, query, selection]);
  const heading = useRef<HTMLHeadingElement>(null);
  const rail = useRef<HTMLElement>(null);
  const results = useRef<HTMLElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const focusSelection = useRef(false);
  const focusResult = useRef<string | null>(null);
  const previousPanel = useRef({ open: detailOpen, selection });
  useEffect(() => {
    const previous = previousPanel.current;
    const active = typeof document === "undefined" ? null : document.activeElement;
    const narrow = window.matchMedia?.("(max-width: 760px)").matches ?? false;
    if (narrow && previous.open !== detailOpen && active) {
      if (detailOpen && results.current?.contains(active)) focusSelection.current = true;
      if (!detailOpen && rail.current?.contains(active))
        focusResult.current = previous.selection ?? selection ?? null;
    }
    previousPanel.current = { open: detailOpen, selection };
    if (focusSelection.current && detailOpen) {
      (heading.current ?? rail.current)?.focus();
      focusSelection.current = false;
    }
    if (focusResult.current && !detailOpen) {
      (rows.current.get(focusResult.current) ?? searchField.current)?.focus();
      focusResult.current = null;
    }
  }, [detail.data, detailDenied, detailOpen, selectedId, selection]);
  const selected = !historyDenied && !detailDenied ? detail.data?.meeting : undefined;
  const offline = history.fetchStatus === "paused";
  const searching = search.trim() !== query;
  const hasFilter = !!query || filter !== "all";
  return (
    <div
      className={`meetings-history${detailOpen && !historyDenied ? " meetings-history--detail" : ""}${!selection || historyDenied ? " meetings-history--single" : ""}`}
    >
      <section
        className="meetings-section meetings-history-results"
        aria-label="Meeting history results"
        ref={results}
      >
        <SectionHead number="01" title="Meeting history" rule />
        <div className="meetings-history-filters">
          <Field>
            <FormLabel htmlFor="meeting-history-search">Search meetings</FormLabel>
            <input
              id="meeting-history-search"
              type="search"
              className="jds-input meetings-input"
              placeholder="Search retained transcripts and notes"
              aria-describedby="meeting-history-search-help"
              maxLength={256}
              value={search}
              ref={searchField}
              onChange={(event) => props.onSearch(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor="meeting-history-filter">State</FormLabel>
            <Select
              id="meeting-history-filter"
              value={filter}
              onChange={(event) => props.onFilter(event.target.value as MeetingHistoryFilter)}
            >
              {historyFilters.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p id="meeting-history-search-help" className="jds-hint">
          Match all words across the current title, notes and transcript. Up to 16 words.
        </p>
        {offline ? (
          <p role="status" className="jds-hint">
            You’re offline. Search will continue when you reconnect.
          </p>
        ) : history.isPending || searching ? (
          <p role="status" className="jds-hint">
            Searching your meetings…
          </p>
        ) : null}
        {history.isError ? (
          <div role="alert">
            <p className="jds-hint jds-hint--error">
              {historyDenied
                ? "Meeting history is unavailable. Sign in again or retry."
                : history.error instanceof ApiError && history.error.status === 400
                  ? "Use up to 16 words and shorten long searches, then try again."
                  : "Couldn’t load meeting history. Retry to continue."}
            </p>
            <Button variant="link" onClick={() => void history.refetch()}>
              Retry loading history
            </Button>
          </div>
        ) : null}
        {history.isSuccess && !meetings.length && !searching && !offline ? (
          <EmptyState
            title={hasFilter ? "No meetings match" : "Your first draft starts here"}
            description={
              hasFilter
                ? "Try different words or choose another state."
                : "Create a meeting draft to keep your personal notes together."
            }
          >
            {hasFilter ? (
              <Button
                variant="secondary"
                onClick={() => {
                  props.onSearch("");
                  props.onFilter("all");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button onClick={onNew}>Create a meeting draft</Button>
            )}
          </EmptyState>
        ) : null}
        {meetings.length > 0 && !searching ? (
          <div className="meetings-history-table">
            <table className="jds-table" aria-label="Your meetings">
              <thead>
                <tr>
                  <th scope="col" aria-label="Draft creation date">
                    Date
                  </th>
                  <th scope="col">Meeting</th>
                  <th scope="col" className="meetings-history-status-column">
                    Capture
                  </th>
                  <th scope="col" className="meetings-history-status-column">
                    Processing
                  </th>
                  <th scope="col" className="meetings-history-status-column">
                    Vault
                  </th>
                </tr>
              </thead>
              <tbody>
                {meetings
                  .filter((meeting) => !(detailDenied && meeting.id === selection))
                  .map((meeting) => (
                    <tr key={meeting.id} aria-selected={meeting.id === selection}>
                      <td>{date(meeting.createdAt)}</td>
                      <td>
                        <Button
                          variant="link"
                          aria-controls="meeting-history-selection"
                          aria-pressed={meeting.id === selection}
                          ref={(element) => {
                            if (element) rows.current.set(meeting.id, element);
                            else rows.current.delete(meeting.id);
                          }}
                          onClick={() => {
                            focusSelection.current =
                              window.matchMedia?.("(max-width: 760px)").matches ?? false;
                            props.onSelect(meeting.id);
                          }}
                        >
                          {meeting.title}
                        </Button>
                        <p className="jds-table__sub">
                          {transcriptSpan(meeting)
                            ? `Transcript ${transcriptSpan(meeting)}`
                            : meeting.hasNotes
                              ? "Saved personal notes"
                              : "Draft"}
                        </p>
                        <p className="jds-hint meetings-history-mobile-status">
                          Capture unavailable · {processingStatus(meeting)} · {vaultStatus(meeting)}
                        </p>
                      </td>
                      <td className="meetings-history-status-column">Unavailable</td>
                      <td className="meetings-history-status-column">
                        {processingStatus(meeting)}
                      </td>
                      <td className="meetings-history-status-column">{vaultStatus(meeting)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {history.hasNextPage && !searching && !historyDenied ? (
          <Button
            variant="secondary"
            disabled={history.isFetchingNextPage || offline}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading more…" : "Load older meetings"}
          </Button>
        ) : null}
        {meetings.length > 0 ? (
          <section className="meetings-section meetings-history-followup">
            <SectionHead number="02" title="Pick up the conversation" rule />
            <p className="jds-hint">
              Select a meeting to open its review or ask Moss about its retained transcript.
            </p>
          </section>
        ) : null}
      </section>
      {selection && !historyDenied ? (
        <>
          <div className="meetings-history-divider">
            <Divider orientation="vertical" />
          </div>
          <aside
            id="meeting-history-selection"
            className="meetings-history-rail"
            aria-label="Selected meeting"
            tabIndex={-1}
            ref={rail}
          >
            <div className="meetings-history-back">
              <Button
                variant="secondary"
                onClick={() => {
                  focusResult.current = selection;
                  props.onResults();
                }}
              >
                Back to results
              </Button>
            </div>
            {detail.fetchStatus === "paused" ? (
              <p role="status" className="jds-hint">
                You’re offline. This meeting will refresh when you reconnect.
              </p>
            ) : detail.isPending ? (
              <p role="status" className="jds-hint">
                Loading selected meeting…
              </p>
            ) : null}
            {detail.isError ? (
              <div role="alert">
                <p className="jds-hint">
                  {detailDenied
                    ? "This meeting is unavailable. Choose another meeting."
                    : "Couldn’t refresh the selected meeting. Retry to check its status."}
                </p>
                <Button variant="link" onClick={() => void detail.refetch()}>
                  Retry selected meeting
                </Button>
              </div>
            ) : null}
            {selected ? (
              <MeetingHistoryRail
                meeting={selected}
                refreshing={detail.isFetching || detail.isError || searching}
                offline={detail.fetchStatus === "paused"}
                headingRef={heading}
                onOpen={onOpen}
              />
            ) : null}
          </aside>
        </>
      ) : null}
    </div>
  );
}
