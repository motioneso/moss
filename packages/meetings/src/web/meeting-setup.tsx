import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import { Button, Field, FormLabel, SectionHead } from "@moss/ui";
import type { CreateMeetingRecordInput } from "@moss/shared";
import { createMeeting, meetingKeys } from "./client.js";
import { useSessionDraft } from "./session-draft.js";

interface SetupDraft {
  readonly title: string;
  readonly request: CreateMeetingRecordInput | null;
  readonly creating: boolean;
  readonly error: string | null;
}
const setupKey = ["meetings", "setup-draft"] as const;
export function MeetingSetup({ onCreated }: { readonly onCreated: (id: string) => void }) {
  const client = useQueryClient();
  const form = useSessionDraft<SetupDraft>(setupKey, () => ({
    title: "",
    request: null,
    creating: false,
    error: null
  }));
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const title = form.data.title;
  const titleValid = !title.includes("\0") && new TextEncoder().encode(title.trim()).length <= 240;
  async function submit() {
    const current = client.getQueryData<SetupDraft>(setupKey);
    if (!current || current.creating || !titleValid) return;
    const request = current.request ?? {
      title: current.title.trim() || "New meeting",
      requestKey: randomUuid()
    };
    const ownsSubmission = () => {
      const pending = client.getQueryData<SetupDraft>(setupKey);
      return (
        form.currentSession() &&
        pending?.creating === true &&
        pending.request?.requestKey === request.requestKey
      );
    };
    form.update((value) => ({ ...value, request, creating: true, error: null }));
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12000);
    try {
      const { meeting, created } = await createMeeting(request, controller.signal);
      if (!ownsSubmission()) return;
      if (created) client.setQueryData(meetingKeys.record(meeting.id), { meeting });
      form.update(() => ({
        title: "",
        request: null,
        creating: false,
        error: null
      }));
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      if (active.current) onCreated(meeting.id);
    } catch (error) {
      if (!ownsSubmission()) return;
      form.update((value) => ({
        ...value,
        creating: false,
        request: error instanceof ApiError && error.status === 400 ? null : value.request,
        error:
          "Couldn’t confirm the meeting. Retry uses the same request so you won’t create a duplicate."
      }));
    } finally {
      clearTimeout(deadline);
    }
  }
  return (
    <section className="meetings-section">
      <SectionHead number="01" title="New meeting" rule />
      <div className="meetings-title-input">
        <Field>
          <FormLabel htmlFor="meeting-title">Meeting title (optional)</FormLabel>
          <input
            className="jds-input meetings-input"
            id="meeting-title"
            value={title}
            maxLength={240}
            disabled={form.data.creating || !!form.data.request}
            placeholder="New meeting"
            onChange={(event) => {
              const title = event.target.value;
              form.update((current) => ({ ...current, title }));
            }}
          />
        </Field>
      </div>
      {!titleValid ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Use a shorter title and remove unsupported characters.
        </p>
      ) : null}
      {form.data.error ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {form.data.error}
        </p>
      ) : null}
      <div className="meetings-actions">
        <Button disabled={form.data.creating || !titleValid} onClick={() => void submit()}>
          {form.data.creating
            ? "Opening meeting…"
            : form.data.error
              ? "Retry opening meeting"
              : "New meeting"}
        </Button>
      </div>
    </section>
  );
}
