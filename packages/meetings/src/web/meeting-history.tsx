import { useState } from "react";
import { useMeetingDate } from "./locale.js";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, EmptyState, Field, FormLabel, SectionHead, Select } from "@moss/ui";
import type { MeetingRecordCursor } from "@moss/shared";
import { listMeetings, meetingKeys, PAGE_SIZE } from "./client.js";

export function MeetingHistory({
  onOpen,
  onNew
}: {
  readonly onOpen: (id: string) => void;
  readonly onNew: () => void;
}) {
  const date = useMeetingDate();
  const [search, setSearch] = useState("");
  const [notesFilter, setNotesFilter] = useState("all");
  const history = useInfiniteQuery({
    queryKey: meetingKeys.history,
    initialPageParam: undefined as MeetingRecordCursor | undefined,
    queryFn: ({ pageParam }) => listMeetings(pageParam),
    getNextPageParam: ({ meetings }) =>
      meetings.length === PAGE_SIZE ? meetings.at(-1) : undefined
  });
  const meetings = history.data?.pages.flatMap((page) => page.meetings) ?? [];
  const matches = meetings.filter(
    (meeting) =>
      (!search.trim() ||
        `${meeting.title} ${meeting.personalNotes}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase())) &&
      (notesFilter === "all" ||
        (notesFilter === "notes" ? !!meeting.personalNotes.trim() : !meeting.personalNotes.trim()))
  );
  return (
    <section className="meetings-section">
      <SectionHead number="01" title="Meeting history" rule />
      {history.isPending ? (
        <p role="status" className="jds-hint">
          Loading your meeting drafts…
        </p>
      ) : null}
      {history.isError ? (
        <div role="alert">
          <p className="jds-hint jds-hint--error">Couldn’t load meeting drafts.</p>
          <Button variant="link" onClick={() => void history.refetch()}>
            Retry loading history
          </Button>
        </div>
      ) : null}
      {history.isSuccess && meetings.length === 0 ? (
        <EmptyState
          title="Your first draft starts here"
          description="Create a meeting draft to keep your personal notes together."
        >
          <Button onClick={onNew}>Create a meeting draft</Button>
        </EmptyState>
      ) : null}
      {meetings.length > 0 ? (
        <>
          <div className="meetings-history-filters">
            <Field>
              <FormLabel htmlFor="meeting-history-search">
                Search loaded meetings and notes
              </FormLabel>
              <input
                id="meeting-history-search"
                type="search"
                className="jds-input meetings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <Field>
              <FormLabel htmlFor="meeting-history-filter">Notes</FormLabel>
              <Select
                id="meeting-history-filter"
                value={notesFilter}
                onChange={(event) => setNotesFilter(event.target.value)}
              >
                <option value="all">All meetings</option>
                <option value="notes">With saved notes</option>
                <option value="empty">Without saved notes</option>
              </Select>
            </Field>
          </div>
          <div className="meetings-history-table">
            <table className="jds-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Meeting</th>
                  <th scope="col">Notes</th>
                  <th scope="col">Last edited</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((meeting) => (
                  <tr key={meeting.id}>
                    <td>{date(meeting.createdAt)}</td>
                    <td>
                      <Button variant="link" onClick={() => onOpen(meeting.id)}>
                        {meeting.title}
                      </Button>
                    </td>
                    <td>{meeting.personalNotes.trim() ? "Saved" : "No notes"}</td>
                    <td>{date(meeting.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!matches.length ? (
            <p role="status" className="jds-hint">
              No loaded meetings match. Change the search or load older meetings.
            </p>
          ) : null}
          {history.hasNextPage ? (
            <p className="jds-hint">
              Search covers the meetings loaded here. Load older drafts to include more.
            </p>
          ) : null}
        </>
      ) : null}
      {history.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading more…" : "Load older drafts"}
        </Button>
      ) : null}
    </section>
  );
}
