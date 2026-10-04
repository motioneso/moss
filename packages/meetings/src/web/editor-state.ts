import type { MeetingRecord, PutMeetingNotesInput } from "@moss/shared";

/** Kept only in the authenticated query cache, cleared by the shell on sign-out. */
export interface MeetingEditorState {
  readonly base: MeetingRecord;
  readonly text: string;
  readonly pending?: PutMeetingNotesInput;
  readonly phase: "idle" | "saving" | "failed" | "conflict";
  readonly latest?: MeetingRecord;
}
export function newEditor(base: MeetingRecord): MeetingEditorState {
  return { base, text: base.personalNotes, phase: "idle" };
}
export function beginNoteSave(state: MeetingEditorState, requestKey: string): MeetingEditorState {
  return {
    ...state,
    phase: "saving",
    pending: state.pending ?? {
      meetingId: state.base.id,
      expectedRevision: state.base.notesRevision,
      personalNotes: state.text,
      requestKey
    }
  };
}
export function finishNoteSave(
  state: MeetingEditorState,
  meeting: MeetingRecord
): MeetingEditorState {
  // An acknowledged retry may be older than current typing; never replace the editor text.
  return { base: meeting, text: state.text, phase: "idle" };
}
export function rebaseNoteEdits(state: MeetingEditorState): MeetingEditorState {
  return state.latest ? { base: state.latest, text: state.text, phase: "idle" } : state;
}
export function hasUnsavedNotes(state: MeetingEditorState): boolean {
  return state.text !== state.base.personalNotes || state.pending !== undefined;
}
