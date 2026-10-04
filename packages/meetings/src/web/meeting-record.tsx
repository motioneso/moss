import { useMeetingDate } from "./locale.js";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid, useMeetingChat } from "@moss/module-web-sdk";
import { Button, EmptyState, Field, FormLabel, Note, SectionHead } from "@moss/ui";
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
  if (record.isPending || record.isFetching)
    return (
      <p role="status" className="jds-hint">
        Loading your draft…
      </p>
    );
  if (record.isError)
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
  return (
    <MeetingNotes
      meeting={record.data.meeting}
      onDeleted={onBack}
      transcriptRevision={transcriptRevision}
      onTranscriptRevisionChange={setTranscriptRevision}
    />
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
  const date = useMeetingDate();
  const { openMeetingChat } = useMeetingChat();
  const transcript = useMeetingTranscript(meeting.id);
  const canAsk =
    !transcript.isError && !transcript.isFetching && !!transcript.data?.snapshot.segments.length;
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
  const notesValid =
    !state.text.includes("\0") && new TextEncoder().encode(state.text).length <= 64000;
  function update(change: (current: MeetingEditorState) => MeetingEditorState) {
    client.setQueryData<MeetingEditorState>(key, (current) =>
      current ? change(current) : undefined
    );
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
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
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
    client.setQueryData(key, next);
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
    <div className="meetings-workspace">
      <div className="meetings-section">
        <TranscriptEvidence meetingId={meeting.id} />
        <MeetingTranscript
          meetingId={meeting.id}
          revision={transcriptRevision}
          onRevisionChange={onTranscriptRevisionChange}
        />
        <section className="meetings-section">
          <SectionHead number="02" title="My notes" rule meta="Draft · Not recorded" />
          <Field>
            <FormLabel htmlFor="meeting-personal-notes">Personal notes</FormLabel>
            <textarea
              id="meeting-personal-notes"
              className="jds-textarea meetings-input meetings-notes"
              maxLength={64000}
              value={state.text}
              onChange={(event) => update((current) => ({ ...current, text: event.target.value }))}
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
                    <FormLabel htmlFor="meeting-current-notes">
                      Current saved notes · revision {state.latest.notesRevision}
                    </FormLabel>
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
            <Button
              variant="quiet"
              disabled={state.phase === "saving"}
              onClick={() => setShowDelete(true)}
            >
              Delete draft
            </Button>
          </div>
        </section>
      </div>
      <aside className="meetings-section">
        <SectionHead number="03" title="Meeting details" rule />
        <Note variant="practical">
          Native audio capture and summaries are not available. Retained transcript text, when
          available, is shown separately from your personal notes.
        </Note>
        <Button
          variant="secondary"
          disabled={!canAsk}
          aria-describedby="meeting-chat-unavailable"
          onClick={() => openMeetingChat({ meetingId: meeting.id, title: meeting.title })}
        >
          Ask Moss
        </Button>
        <p id="meeting-chat-unavailable" className="jds-hint">
          {canAsk
            ? "Ask about the retained transcript in Moss chat."
            : "Meeting chat needs an available transcript."}
        </p>
        <p className="jds-hint">Created {date(meeting.createdAt)}</p>
      </aside>
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
