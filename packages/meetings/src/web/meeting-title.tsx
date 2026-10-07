import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, requestJson, randomUuid, setSessionUnsavedChanges } from "@moss/module-web-sdk";
import { Button, RowButton, SectionHead } from "@moss/ui";
import type { MeetingRecord } from "@moss/shared";
import { getMeeting, isMeetingAccessDenied, meetingKeys } from "./client.js";
import { useSessionDraft } from "./session-draft.js";
interface TitleState {
  text: string;
  base: string;
  saving: boolean;
  error: string | null;
  conflict?: string;
  observedTitle: string;
  requestKey?: string;
}
export function MeetingTitle({ meeting }: { readonly meeting: MeetingRecord }) {
  const client = useQueryClient();
  const key = ["meetings", "title", meeting.id] as const;
  const draft = useSessionDraft<TitleState>(key, () => ({
    text: meeting.title,
    base: meeting.title,
    observedTitle: meeting.title,
    saving: false,
    error: null
  }));
  const update = useCallback(
    (change: (current: TitleState) => TitleState) => {
      const next = draft.update(change);
      // Completion can occur after navigation unmounts the input.
      if (next)
        setSessionUnsavedChanges(client, `meetings:${meeting.id}:title`, next.text !== next.base);
      return next;
    },
    [draft.update, client, meeting.id]
  );
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dirty = draft.data.text !== draft.data.base;
  useEffect(() => {
    setSessionUnsavedChanges(client, `meetings:${meeting.id}:title`, dirty);
  }, [client, meeting.id, dirty]);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (draft.data.saving || draft.data.observedTitle === meeting.title) return;
    update((s) => ({
      ...s,
      observedTitle: meeting.title,
      ...(!dirty ? { text: meeting.title, base: meeting.title, error: null } : {})
    }));
  }, [meeting.title, dirty, draft.data.saving, draft.data.observedTitle, update]);
  async function save() {
    const state = client.getQueryData<TitleState>(key);
    if (!state || state.saving || state.conflict !== undefined) return;
    const sent = state.text.trim();
    if (!sent || sent.includes("\0") || new TextEncoder().encode(sent).length > 240) {
      update((s) => ({ ...s, error: "Use a title of up to 240 bytes." }));
      return;
    }
    if (sent === state.base) {
      update((current) => ({ ...current, text: sent, error: null }));
      setEditing(false);
      return;
    }
    const expectedTitle = state.base;
    const requestKey = randomUuid();
    update((s) => ({ ...s, saving: true, requestKey, error: null }));
    const current = () =>
      draft.currentSession() &&
      client.getQueryData<TitleState>(key)?.requestKey === requestKey &&
      !isMeetingAccessDenied(client.getQueryState(meetingKeys.record(meeting.id))?.error);
    try {
      const result = await requestJson<{ meeting: MeetingRecord }>(
        `/api/meetings/records/${encodeURIComponent(meeting.id)}/title`,
        { method: "PUT", body: { title: sent, expectedTitle } }
      );
      if (!current()) return;
      await client.cancelQueries({ queryKey: meetingKeys.record(meeting.id), exact: true });
      if (!current()) return;
      client.setQueryData<{ meeting: MeetingRecord }>(meetingKeys.record(meeting.id), (cached) => ({
        meeting: {
          ...result.meeting,
          ...(cached && cached.meeting.notesRevision > result.meeting.notesRevision
            ? {
                personalNotes: cached.meeting.personalNotes,
                notesRevision: cached.meeting.notesRevision
              }
            : {})
        }
      }));
      update((s) => ({
        ...s,
        base: result.meeting.title,
        text: s.text.trim() === sent ? result.meeting.title : s.text,
        saving: false,
        requestKey: undefined,
        error: null
      }));
      void client.invalidateQueries({ queryKey: meetingKeys.record(meeting.id), exact: true });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      setEditing(false);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await getMeeting(meeting.id);
          if (current())
            update((s) => ({
              ...s,
              saving: false,
              conflict: latest.meeting.title,
              error: "The title changed elsewhere. Your title is kept."
            }));
        } catch {
          if (current())
            update((s) => ({
              ...s,
              saving: false,
              error: "Couldn’t load the current title. Try again."
            }));
        }
      } else
        update((s) => ({
          ...s,
          saving: false,
          error: "Couldn’t save the title. Try again."
        }));
    }
  }
  return (
    <div className="meetings-title">
      {editing ? (
        <input
          ref={input}
          aria-label="Meeting title"
          className="jds-input meetings-input"
          value={draft.data.text}
          maxLength={240}
          disabled={draft.data.saving}
          onChange={(event) => {
            const text = event.target.value;
            update((s) => ({ ...s, text }));
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") {
              update(() => ({
                text: meeting.title,
                base: meeting.title,
                observedTitle: meeting.title,
                saving: false,
                error: null
              }));
              setEditing(false);
            }
          }}
        />
      ) : (
        <SectionHead
          titleAs="h1"
          title={
            <RowButton aria-label="Edit meeting title" onClick={() => setEditing(true)}>
              {draft.data.text === "Untitled meeting" ? "New meeting" : draft.data.text}
            </RowButton>
          }
        />
      )}
      {draft.data.saving ? <span className="jds-hint">Saving…</span> : null}
      {draft.data.error ? (
        <p role="alert" className="jds-hint">
          {draft.data.error}{" "}
          {draft.data.conflict !== undefined ? (
            <>
              <span>Current title: {draft.data.conflict}. </span>
              <Button
                variant="link"
                onClick={() => {
                  update((s) => ({
                    ...s,
                    base: s.conflict!,
                    conflict: undefined,
                    error: null
                  }));
                  setEditing(true);
                }}
              >
                Keep my title
              </Button>
              <Button
                variant="link"
                onClick={() => {
                  update((current) => ({
                    ...current,
                    text: current.conflict!,
                    base: current.conflict!,
                    conflict: undefined,
                    error: null
                  }));
                  setEditing(false);
                }}
              >
                Load current title
              </Button>
            </>
          ) : (
            <Button
              variant="link"
              onClick={() => {
                setEditing(true);
                void save();
              }}
            >
              Retry title save
            </Button>
          )}
        </p>
      ) : null}
    </div>
  );
}
