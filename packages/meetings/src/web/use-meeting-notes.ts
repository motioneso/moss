import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid, setSessionUnsavedChanges } from "@moss/module-web-sdk";
import type { MeetingRecord as MeetingRecordDto } from "@moss/shared";
import { getMeeting, isMeetingAccessDenied, meetingKeys, saveMeetingNotes } from "./client.js";
import {
  beginNoteSave,
  finishNoteSave,
  hasUnsavedNotes,
  newEditor,
  rebaseNoteEdits,
  type MeetingEditorState
} from "./editor-state.js";
import { useSessionDraft } from "./session-draft.js";
export function useMeetingNotesEditor(meeting: MeetingRecordDto) {
  const client = useQueryClient();
  const key = useMemo(() => meetingKeys.editor(meeting.id), [meeting.id]);
  // Deliberately memory-only: recovery across app navigation without putting private notes in localStorage.
  const editor = useSessionDraft<MeetingEditorState>(key, () => newEditor(meeting));
  const state = editor.data;
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictError, setConflictError] = useState(false);
  const dirty = hasUnsavedNotes(state);
  useEffect(() => {
    setSessionUnsavedChanges(client, `meetings:${meeting.id}:notes`, dirty);
  }, [client, meeting.id, dirty]);
  const notesValid =
    !state.text.includes("\0") && new TextEncoder().encode(state.text).length <= 64000;
  function update(change: (current: MeetingEditorState) => MeetingEditorState) {
    const next = editor.update(change);
    // A pending save can finish after navigation unmounts this editor. Keep the shell's
    // marker aligned with the cached edits without depending on a mounted-view effect.
    if (next)
      setSessionUnsavedChanges(client, `meetings:${meeting.id}:notes`, hasUnsavedNotes(next));
  }
  useEffect(() => {
    editor.update((current) =>
      current &&
      current.phase === "idle" &&
      !hasUnsavedNotes(current) &&
      meeting.notesRevision > current.base.notesRevision
        ? newEditor(meeting)
        : current
    );
  }, [meeting, editor.update]);
  async function loadCurrent() {
    const pendingKey = client.getQueryData<MeetingEditorState>(key)?.pending?.requestKey;
    setConflictLoading(true);
    setConflictError(false);
    try {
      const { meeting: latest } = await getMeeting(meeting.id);
      if (!editor.currentSession()) return;
      update((current) =>
        current.phase === "conflict" && current.pending?.requestKey === pendingKey
          ? { ...current, latest }
          : current
      );
    } catch {
      if (editor.currentSession()) setConflictError(true);
    } finally {
      if (editor.currentSession()) setConflictLoading(false);
    }
  }
  async function save() {
    const current = client.getQueryData<MeetingEditorState>(key);
    if (!current) return;
    if (current.phase === "saving" || current.phase === "conflict") return;
    if (!current.pending && (!notesValid || !hasUnsavedNotes(current))) return;
    const next = beginNoteSave(current, randomUuid());
    const stillCurrent = () =>
      editor.currentSession() &&
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
        known && known.notesRevision > result.meeting.notesRevision
          ? known
          : {
              ...result.meeting,
              ...(known && known.updatedAt > result.meeting.updatedAt
                ? { title: known.title, updatedAt: known.updatedAt }
                : {})
            };
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
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty || !notesValid || state.phase !== "idle") return;
    const timer = setTimeout(() => void saveRef.current(), 650);
    return () => clearTimeout(timer);
  }, [dirty, notesValid, state.text, state.phase]);
  return {
    state,
    dirty,
    notesValid,
    conflictLoading,
    conflictError,
    save,
    loadCurrent,
    change: (text: string) => update((current) => ({ ...current, text })),
    keepMine: () => update(rebaseNoteEdits)
  };
}
