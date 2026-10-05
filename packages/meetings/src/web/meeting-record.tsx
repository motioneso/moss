import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  randomUuid,
  useMeetingChat,
  setSessionUnsavedChanges
} from "@moss/module-web-sdk";
import { Badge, Button, EmptyState, Field, FormLabel, SectionHead, Tabs } from "@moss/ui";
import type { MeetingRecord as MeetingRecordDto } from "@moss/shared";
import {
  getMeeting,
  isMeetingAccessDenied,
  meetingKeys,
  meetingRecordQueryOptions,
  saveMeetingNotes
} from "./client.js";
import {
  beginNoteSave,
  finishNoteSave,
  hasUnsavedNotes,
  newEditor,
  rebaseNoteEdits,
  type MeetingEditorState
} from "./editor-state.js";
import { TranscriptEvidence } from "./transcript-evidence.js";
import { MeetingTranscript, useMeetingTranscript } from "./meeting-transcript.js";
import { MeetingSummary } from "./meeting-summary.js";
import { DeleteMeetingDialog } from "./delete-meeting-dialog.js";

export function MeetingRecord({
  id,
  onBack
}: {
  readonly id: string;
  readonly onBack: () => void;
}) {
  const [transcriptRevision, setTranscriptRevision] = useState<number>();
  const record = useQuery(meetingRecordQueryOptions(id));
  const { clearMeetingChat } = useMeetingChat();
  const accessDenied = isMeetingAccessDenied(record.error);
  useEffect(() => {
    if (accessDenied) clearMeetingChat(id);
  }, [accessDenied, clearMeetingChat, id]);
  if (record.isPending && !record.data)
    return (
      <p role="status" className="jds-hint">
        Loading your draft…
      </p>
    );
  if (record.isError && (accessDenied || !record.data))
    return (
      <EmptyState
        title={
          record.error instanceof ApiError && record.error.status === 404
            ? "This draft is unavailable"
            : "Couldn’t load this draft"
        }
        description="Return to history or try again."
      >
        <div className="meetings-actions">
          <Button onClick={() => void record.refetch()}>Retry loading draft</Button>
          <Button variant="secondary" onClick={onBack}>
            Back to history
          </Button>
        </div>
      </EmptyState>
    );
  if (!record.data) return null;
  return (
    <>
      {record.isFetching ? (
        <p role="status" className="jds-hint">
          Refreshing meeting…
        </p>
      ) : null}
      {record.isError ? (
        <p role="status" className="jds-hint">
          Couldn’t refresh this meeting. Your open review is kept.{" "}
          <Button variant="link" onClick={() => void record.refetch()}>
            Retry
          </Button>
        </p>
      ) : null}
      <MeetingNotes
        meeting={record.data.meeting}
        onDeleted={onBack}
        transcriptRevision={transcriptRevision}
        onTranscriptRevisionChange={setTranscriptRevision}
      />
    </>
  );
}

export function MeetingNotes({
  meeting,
  onDeleted,
  transcriptRevision,
  onTranscriptRevisionChange
}: {
  readonly meeting: MeetingRecordDto;
  readonly onDeleted: () => void;
  readonly transcriptRevision: number | undefined;
  readonly onTranscriptRevisionChange: (revision: number | undefined) => void;
}) {
  const [tab, setTab] = useState<"summary" | "transcript" | "notes">("summary");
  const { openMeetingChat } = useMeetingChat();
  const transcript = useMeetingTranscript(meeting.id);
  const snapshot = transcript.isError ? undefined : transcript.data?.snapshot;
  const canAsk = !transcript.isError && !transcript.isFetching && !!snapshot?.segments.length;
  const client = useQueryClient();
  const key = useMemo(() => meetingKeys.editor(meeting.id), [meeting.id]);
  // Deliberately memory-only: recovery across app navigation without putting private notes in localStorage.
  const editor = useQuery<MeetingEditorState>({
    queryKey: key,
    queryFn: () => newEditor(meeting),
    initialData: () => client.getQueryData<MeetingEditorState>(key) ?? newEditor(meeting),
    enabled: false,
    gcTime: Infinity
  });
  const state = editor.data;
  const [showDelete, setShowDelete] = useState(false);
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictError, setConflictError] = useState(false);
  const dirty = hasUnsavedNotes(state);
  useEffect(() => {
    setSessionUnsavedChanges(client, `meetings:${meeting.id}:notes`, dirty);
  }, [client, meeting.id, dirty]);
  const notesValid =
    !state.text.includes("\0") && new TextEncoder().encode(state.text).length <= 64000;
  function update(change: (current: MeetingEditorState) => MeetingEditorState) {
    const next = client.setQueryData<MeetingEditorState>(key, (current) =>
      current ? change(current) : undefined
    );
    // A pending save can finish after navigation unmounts this editor. Keep the shell's
    // marker aligned with the cached edits without depending on a mounted-view effect.
    if (next)
      setSessionUnsavedChanges(client, `meetings:${meeting.id}:notes`, hasUnsavedNotes(next));
  }
  useEffect(() => {
    client.setQueryData<MeetingEditorState>(key, (current) =>
      current &&
      current.phase === "idle" &&
      !hasUnsavedNotes(current) &&
      meeting.notesRevision > current.base.notesRevision
        ? newEditor(meeting)
        : current
    );
  }, [client, meeting, key]);
  async function loadCurrent() {
    const pendingKey = client.getQueryData<MeetingEditorState>(key)?.pending?.requestKey;
    setConflictLoading(true);
    setConflictError(false);
    try {
      const { meeting: latest } = await getMeeting(meeting.id);
      update((current) =>
        current.phase === "conflict" && current.pending?.requestKey === pendingKey
          ? { ...current, latest }
          : current
      );
    } catch {
      setConflictError(true);
    } finally {
      setConflictLoading(false);
    }
  }
  async function save() {
    const current = client.getQueryData<MeetingEditorState>(key);
    if (!current) return;
    if (current.phase === "saving" || current.phase === "conflict") return;
    if (!current.pending && (!notesValid || !hasUnsavedNotes(current))) return;
    const next = beginNoteSave(current, randomUuid());
    const stillCurrent = () =>
      !isMeetingAccessDenied(client.getQueryState(meetingKeys.record(meeting.id))?.error) &&
      client.getQueryData<MeetingEditorState>(key)?.pending?.requestKey ===
        next.pending?.requestKey;
    update(() => next);
    try {
      const result = await saveMeetingNotes(next.pending!);
      if (!stillCurrent()) return;
      const known = client.getQueryData<{ meeting: MeetingRecordDto }>(
        meetingKeys.record(meeting.id)
      )?.meeting;
      const acknowledged =
        known && known.notesRevision > result.meeting.notesRevision ? known : result.meeting;
      update((current) => {
        const saved = finishNoteSave(current, result.meeting);
        return acknowledged.notesRevision > result.meeting.notesRevision
          ? { ...saved, phase: "conflict", latest: acknowledged }
          : saved;
      });
      client.setQueryData(meetingKeys.record(meeting.id), { meeting: acknowledged });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
    } catch (error) {
      if (!stillCurrent()) return;
      const rejected = error instanceof ApiError && error.status === 400;
      const conflict = error instanceof ApiError && error.status === 409;
      update((current) => ({
        ...current,
        pending: rejected ? undefined : current.pending,
        phase: conflict ? "conflict" : "failed"
      }));
      if (conflict) await loadCurrent();
    }
  }
  return (
    <div className="meetings-section">
      <div className="meetings-actions meetings-review-status">
        <Badge tone={snapshot?.containsProvisional ? "amber" : "neutral"}>
          {snapshot?.segments.length ? "Ready to review" : "Draft"}
        </Badge>
        <span className="jds-hint">
          {snapshot?.containsProvisional
            ? "Some transcript text is still provisional"
            : snapshot?.segments.length
              ? "Retained transcript available"
              : "No recording attached"}
        </span>
        <Button variant="link" onClick={() => setTab("transcript")}>
          View transcript
        </Button>
        <Button
          variant="secondary"
          disabled={!canAsk}
          aria-describedby="meeting-chat-unavailable"
          onClick={() => openMeetingChat({ meetingId: meeting.id, title: meeting.title })}
        >
          Ask Moss
        </Button>
        <Button
          variant="quiet"
          disabled={state.phase === "saving"}
          onClick={() => setShowDelete(true)}
        >
          Delete draft
        </Button>
      </div>
      {!canAsk ? (
        <p id="meeting-chat-unavailable" className="jds-hint">
          Ask Moss needs an available transcript.
        </p>
      ) : (
        <span id="meeting-chat-unavailable" className="jds-hint">
          Ask about this meeting in Moss chat.
        </span>
      )}
      <TranscriptEvidence meetingId={meeting.id} />
      <Tabs
        id="meeting-review"
        ariaLabel="Meeting review sections"
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "summary",
            label: "Summary and actions",
            content: (
              <MeetingSummary
                meeting={meeting}
                transcriptRevision={transcript.data?.snapshot.transcriptRevision ?? 0}
                sourceLoading={
                  transcript.isFetching ||
                  (transcript.isError &&
                    !(transcript.error instanceof ApiError && transcript.error.status === 404))
                }
                unsavedNotes={dirty}
              />
            )
          },
          {
            value: "transcript",
            label: "Transcript",
            count: transcript.data
              ? `${transcript.data.snapshot.segments.length}${transcript.data.snapshot.omittedSegments ? "+" : ""} turns`
              : undefined,
            content: (
              <MeetingTranscript
                meetingId={meeting.id}
                revision={transcriptRevision}
                onRevisionChange={onTranscriptRevisionChange}
              />
            )
          },
          {
            value: "notes",
            label: "My notes",
            count: state.text.trim() ? "1 note" : "0 notes",
            content: (
              <section className="meetings-section">
                <SectionHead number="01" title="My notes" rule />
                <Field>
                  <FormLabel htmlFor="meeting-personal-notes">Personal notes</FormLabel>
                  <textarea
                    id="meeting-personal-notes"
                    className="jds-textarea meetings-input meetings-notes"
                    maxLength={64000}
                    value={state.text}
                    onChange={(event) =>
                      update((current) => ({ ...current, text: event.target.value }))
                    }
                  />
                </Field>
                <p role="status" className="jds-hint">
                  {state.phase === "saving"
                    ? "Saving…"
                    : state.phase === "failed"
                      ? "Save failed. Correct any invalid notes, then retry."
                      : state.phase === "conflict"
                        ? "Notes changed elsewhere. Review the saved version before retrying."
                        : dirty
                          ? "Unsaved changes. Kept while you navigate this signed-in session; save before closing or signing out."
                          : "Saved"}
                </p>
                {state.phase === "conflict" ? (
                  <div className="meetings-section">
                    {conflictLoading ? (
                      <p role="status" className="jds-hint">
                        Loading the current saved notes…
                      </p>
                    ) : null}
                    {conflictError ? (
                      <p role="alert" className="jds-hint jds-hint--error">
                        Couldn’t load the current notes. Your edits have not been replaced.
                      </p>
                    ) : null}
                    {state.latest ? (
                      <>
                        <Field>
                          <FormLabel htmlFor="meeting-current-notes">Current saved notes</FormLabel>
                          <textarea
                            id="meeting-current-notes"
                            className="jds-textarea meetings-input"
                            readOnly
                            value={state.latest.personalNotes}
                            rows={6}
                          />
                        </Field>
                        <Button variant="secondary" onClick={() => update(rebaseNoteEdits)}>
                          Keep my version
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={conflictLoading}
                        onClick={() => void loadCurrent()}
                      >
                        Load current notes
                      </Button>
                    )}
                  </div>
                ) : null}
                {!notesValid ? (
                  <p role="alert" className="jds-hint jds-hint--error">
                    Shorten these notes or remove unsupported characters before saving.
                  </p>
                ) : null}
                <div className="meetings-actions">
                  <Button
                    disabled={
                      !dirty ||
                      (!notesValid && !state.pending) ||
                      state.phase === "saving" ||
                      state.phase === "conflict"
                    }
                    onClick={() => void save()}
                  >
                    {state.phase === "failed" ? "Retry save" : "Save notes"}
                  </Button>
                </div>
              </section>
            )
          }
        ]}
      />
      {showDelete ? (
        <DeleteMeetingDialog
          meeting={meeting}
          onClose={() => setShowDelete(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}
