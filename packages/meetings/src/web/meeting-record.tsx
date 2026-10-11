import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, useMeetingChat } from "@moss/module-web-sdk";
import { buttonLinkClassName, Button, EmptyState, Menu, Tabs } from "@moss/ui";
import type {
  MeetingRecord as MeetingRecordDto,
  MeetingCaptureBrowserStatus,
  MeetingOutputsResponse
} from "@moss/shared";
import {
  discardMeetingPrivateState,
  isMeetingAccessDenied,
  meetingRecordQueryOptions
} from "./client.js";
import { MeetingTranscript, useMeetingTranscript } from "./meeting-transcript.js";
import { MeetingSummary, type SummaryTool } from "./meeting-summary.js";
import { DeleteMeetingDialog } from "./delete-meeting-dialog.js";
import { CapturePanel } from "./capture-panel.js";
import { captureKeys } from "./capture-client.js";
import { outputKeys } from "./output-client.js";
import { MeetingTitle } from "./meeting-title.js";
import { MeetingNotesPane } from "./meeting-notes-pane.js";
import { useMeetingNotesEditor } from "./use-meeting-notes.js";
import { useMeetingDate } from "./locale.js";

export function MeetingRecord({
  id,
  onBack,
  onDeleted
}: {
  readonly id: string;
  readonly onBack: () => void;
  readonly onDeleted: () => void;
}) {
  const client = useQueryClient();
  const record = useQuery(meetingRecordQueryOptions(id));
  const { clearMeetingChat } = useMeetingChat();
  const denied = isMeetingAccessDenied(record.error);
  useEffect(() => {
    if (denied) {
      clearMeetingChat(id);
      // Run after the denied view commits: sibling query notifications must not recreate
      // a mounted editor's initial private draft between fetch rejection and unmount.
      discardMeetingPrivateState(client, id);
    }
  }, [denied, clearMeetingChat, client, id]);
  if (record.isPending && !record.data)
    return (
      <p role="status" className="jds-hint">
        Loading meeting…
      </p>
    );
  if (record.isError && (denied || !record.data))
    return (
      <EmptyState
        title={
          record.error instanceof ApiError && record.error.status === 404
            ? "This meeting is unavailable"
            : "Couldn’t load this meeting"
        }
      >
        <Button onClick={() => void record.refetch()}>Try again</Button>
        <Button variant="link" onClick={onBack}>
          Meetings
        </Button>
      </EmptyState>
    );
  if (!record.data) return null;
  return (
    <>
      {record.isError ? (
        <p role="status" className="jds-hint">
          Couldn’t refresh this meeting.{" "}
          <Button variant="link" onClick={() => void record.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      <MeetingNotes meeting={record.data.meeting} onDeleted={onDeleted} onBack={onBack} />
    </>
  );
}

export function MeetingNotes({
  meeting,
  onDeleted,
  onBack
}: {
  readonly meeting: MeetingRecordDto;
  readonly onDeleted: () => void;
  readonly onBack?: () => void;
}) {
  const [captureActive, setCaptureActive] = useState(false);
  const [tab, setTab] = useState<"transcript" | "notes" | "summary">("notes");
  const [tool, setTool] = useState<SummaryTool | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 760px)").matches
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return;
    const change = () => setNarrow(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const capture = useQuery<MeetingCaptureBrowserStatus>({
    queryKey: captureKeys.status(meeting.id),
    enabled: false
  });
  const outputs = useQuery<MeetingOutputsResponse>({
    queryKey: outputKeys.list(meeting.id),
    enabled: false
  });
  const showSummary =
    capture.data?.capture?.desired === "stopped" ||
    !!outputs.data?.headVersion ||
    tool !== null ||
    tab === "summary";
  const transcript = useMeetingTranscript(meeting.id);
  const editor = useMeetingNotesEditor(meeting);
  const date = useMeetingDate({
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  const transcriptPane = (
    <MeetingTranscript
      meetingId={meeting.id}
      search={search}
      onSearch={setSearch}
      onReference={() => {
        if (narrow) setTab("transcript");
      }}
    />
  );
  const notesPane = <MeetingNotesPane editor={editor} />;
  const summaryPane = (
    <MeetingSummary
      meeting={meeting}
      transcriptRevision={transcript.data?.snapshot.transcriptRevision ?? 0}
      sourceLoading={transcript.isFetching}
      unsavedNotes={editor.dirty}
      tool={tool}
      onCloseTool={() => setTool(null)}
    />
  );
  const items = [
    ...(narrow
      ? [{ value: "transcript" as const, label: "Transcript", content: transcriptPane }]
      : []),
    { value: "notes" as const, label: "Notes", content: notesPane },
    ...(showSummary ? [{ value: "summary" as const, label: "Summary", content: summaryPane }] : [])
  ];
  return (
    <section className="meetings-section" aria-label="Meeting workspace">
      <header className="meetings-record-heading">
        <div>
          {onBack ? (
            <Button variant="link" onClick={onBack}>
              Meetings
            </Button>
          ) : null}
        </div>
        <div className="meetings-actions meetings-record-tools">
          <Link
            className={buttonLinkClassName("link")}
            to="/settings?section=modules&module=meetings"
          >
            Settings
          </Link>
          <Menu
            triggerIcon={<span aria-hidden="true">•••</span>}
            triggerLabel="Meeting actions"
            items={[
              { id: "search", label: "Search transcript" },
              { id: "rewrite", label: "Rewrite summary", disabled: captureActive },
              { id: "versions", label: "Earlier versions" },
              { id: "vault", label: "Save to vault" },
              { id: "copy", label: "Copy as Markdown" },
              {
                id: "delete",
                label: "Delete meeting",
                disabled: captureActive || editor.state.phase === "saving"
              }
            ]}
            onSelect={(action) => {
              if (action === "delete") setShowDelete(true);
              else if (action === "search") {
                setSearch("");
                if (narrow) setTab("transcript");
              } else {
                setTool(action as SummaryTool);
                setTab("summary");
              }
            }}
          />
        </div>
      </header>
      <CapturePanel
        meeting={meeting}
        onLiveChange={setCaptureActive}
        heading={
          <>
            <MeetingTitle meeting={meeting} />
            {meeting.title !== "Untitled meeting" ? (
              <p className="jds-hint">{date(meeting.createdAt)}</p>
            ) : null}
          </>
        }
      />
      <div className="meetings-workspace">
        {!narrow ? transcriptPane : null}
        <Tabs
          id="meeting-review"
          ariaLabel="Meeting sections"
          value={!narrow && tab === "transcript" ? "notes" : tab}
          onChange={setTab}
          items={items}
        />
      </div>
      {!showSummary ? <div hidden>{summaryPane}</div> : null}
      {showDelete ? (
        <DeleteMeetingDialog
          meeting={meeting}
          onClose={() => setShowDelete(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </section>
  );
}
