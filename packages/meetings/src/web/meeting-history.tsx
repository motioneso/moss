import { useMeetingDate } from "./locale.js";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, EmptyState, RowIndex, RowIndexItem, SectionHead } from "@moss/ui";
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
  const history = useInfiniteQuery({
    queryKey: meetingKeys.history,
    initialPageParam: undefined as MeetingRecordCursor | undefined,
    queryFn: ({ pageParam }) => listMeetings(pageParam),
    getNextPageParam: ({ meetings }) =>
      meetings.length === PAGE_SIZE ? meetings.at(-1) : undefined
  });
  const meetings = history.data?.pages.flatMap((page) => page.meetings) ?? [];
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
        <RowIndex>
          {meetings.map((meeting) => (
            <RowIndexItem
              key={meeting.id}
              title={
                <Button variant="link" onClick={() => onOpen(meeting.id)}>
                  {meeting.title}
                </Button>
              }
              excerpt="Draft · Not recorded"
              meta={date(meeting.createdAt)}
            />
          ))}
        </RowIndex>
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
