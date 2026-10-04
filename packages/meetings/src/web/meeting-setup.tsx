import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import { Button, Field, FormLabel, Note, SectionHead, Select, Switch } from "@moss/ui";
import type { CreateMeetingRecordInput } from "@moss/shared";
import {
  createMeeting,
  getMeetingPreferences,
  putMeetingPreferences,
  meetingKeys
} from "./client.js";

const MODES = [
  {
    value: "computer-audio",
    label: "Microphone and computer audio",
    description: "Audio from a selected output device."
  },
  {
    value: "selected-app",
    label: "Microphone and selected app",
    description: "Only the selected app’s output."
  },
  { value: "microphone-only", label: "Microphone only", description: "Your voice or the room." }
] as const;
type CaptureMode = (typeof MODES)[number]["value"];

interface SetupDraft {
  readonly title: string;
  readonly mode: CaptureMode | null;
  readonly request: CreateMeetingRecordInput | null;
  readonly defaultSaving?: boolean;
  readonly createPending?: boolean;
}
const setupKey = ["meetings", "setup-draft"] as const;

export function MeetingSetup({ onCreated }: { readonly onCreated: (id: string) => void }) {
  const client = useQueryClient();
  const form = useQuery<SetupDraft>({
    queryKey: setupKey,
    queryFn: () => ({ title: "", mode: null, request: null }),
    initialData: { title: "", mode: null, request: null },
    enabled: false,
    gcTime: Infinity
  });
  const sessionEntry = useRef(client.getQueryCache().find({ queryKey: setupKey, exact: true }));
  const sameSession = () =>
    client.getQueryCache().find({ queryKey: setupKey, exact: true }) === sessionEntry.current;
  const title = form.data.title;
  const chosenMode = form.data.mode;
  function updateForm(change: Partial<SetupDraft>) {
    if (sameSession())
      client.setQueryData<SetupDraft>(setupKey, (current) =>
        current ? { ...current, ...change } : undefined
      );
  }
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences
  });
  const mode = chosenMode ?? preferences.data?.defaultCaptureMode ?? null;
  const saveDefault = useMutation({
    mutationFn: putMeetingPreferences,
    onMutate: () => updateForm({ defaultSaving: true }),
    onSettled: () => updateForm({ defaultSaving: false }),
    onSuccess: (saved) => {
      if (sameSession()) client.setQueryData(meetingKeys.preferences, saved);
    }
  });
  const titleValid =
    title.trim().length > 0 &&
    !title.includes("\0") &&
    new TextEncoder().encode(title.trim()).length <= 240;
  const create = useMutation({
    mutationFn: createMeeting,
    onSettled: () => updateForm({ createPending: false }),
    onError: (error) => {
      // A definite validation rejection has not created anything; let the person correct input.
      if (error instanceof ApiError && error.status === 400) {
        updateForm({ request: null });
      }
    },
    onSuccess: ({ meeting, created }) => {
      if (!sameSession()) return;
      updateForm({ request: null, title: "", mode: null });
      if (created) client.setQueryData(meetingKeys.record(meeting.id), { meeting });
      else void client.invalidateQueries({ queryKey: meetingKeys.record(meeting.id), exact: true });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      if (active.current) onCreated(meeting.id);
    }
  });
  function submit() {
    const current = client.getQueryData<SetupDraft>(setupKey);
    if (!current || current.createPending) return;
    const input = current.request ?? { title: current.title.trim(), requestKey: randomUuid() };
    updateForm({ request: input, createPending: true });
    create.mutate(input);
  }
  return (
    <>
      <section className="meetings-section">
        <SectionHead number="01" title="Set up your meeting" rule />
        <div className="meetings-title-input">
          <Field>
            <FormLabel htmlFor="meeting-title">Meeting title</FormLabel>
            <input
              className="jds-input meetings-input"
              id="meeting-title"
              value={title}
              maxLength={240}
              disabled={create.isPending || form.data.createPending || form.data.request !== null}
              onChange={(event) => {
                updateForm({ title: event.target.value });
              }}
            />
          </Field>
        </div>
        {title && !titleValid ? (
          <p role="alert" className="jds-hint jds-hint--error">
            Use a shorter title and remove any unsupported characters.
          </p>
        ) : null}
        <div className="meetings-modes" role="group" aria-label="Capture mode">
          {MODES.map((option) => (
            <Field key={option.value}>
              <Button
                variant={mode === option.value ? "accentSoft" : "secondary"}
                aria-pressed={mode === option.value}
                onClick={() => {
                  updateForm({ mode: option.value });
                }}
              >
                {option.label}
              </Button>
              <p className="jds-hint">{option.description}</p>
            </Field>
          ))}
        </div>
        <div className="meetings-actions">
          <Switch
            ariaLabel="Use this capture mode as my default"
            checked={mode !== null && preferences.data?.defaultCaptureMode === mode}
            disabled={
              !mode || !preferences.isSuccess || saveDefault.isPending || form.data.defaultSaving
            }
            onChange={(checked) => {
              if (client.getQueryData<SetupDraft>(setupKey)?.defaultSaving) return;
              updateForm({ defaultSaving: true });
              saveDefault.mutate({ defaultCaptureMode: checked ? mode : null });
            }}
          />
          <span className="jds-hint">Use this capture mode as my default</span>
        </div>
        {preferences.isPending ? (
          <p role="status" className="jds-hint">
            Loading your capture default…
          </p>
        ) : null}
        {preferences.isError ? (
          <div role="alert">
            <p className="jds-hint jds-hint--error">
              Couldn’t load your capture default. You can still choose a mode for this setup.
            </p>
            <Button variant="link" onClick={() => void preferences.refetch()}>
              Retry loading default
            </Button>
          </div>
        ) : null}
        {saveDefault.isPending ? (
          <p role="status" className="jds-hint">
            Saving your default…
          </p>
        ) : null}
        {saveDefault.isError ? (
          <p role="alert" className="jds-hint jds-hint--error">
            Couldn’t save your default. Try the switch again.
          </p>
        ) : null}
        {mode === "computer-audio" ? (
          <Note variant="practical">
            Computer audio can include other apps, media, and notifications on the selected output.
          </Note>
        ) : null}
      </section>
      <section className="meetings-section">
        <SectionHead number="02" title="Check the sources" rule />
        <div className="meetings-sources">
          <Field>
            <FormLabel htmlFor="meeting-microphone">Microphone</FormLabel>
            <Select id="meeting-microphone" disabled>
              <option>Unavailable — native capture not implemented</option>
            </Select>
          </Field>
          <Field>
            <FormLabel htmlFor="meeting-output">
              {mode === "selected-app" ? "Selected app" : "Output audio"}
            </FormLabel>
            <Select id="meeting-output" disabled>
              <option>
                {mode === "microphone-only"
                  ? "Not captured in microphone-only mode"
                  : "Unavailable — native capture not implemented"}
              </option>
            </Select>
          </Field>
        </div>
        <p className="jds-hint" id="meeting-capture-unavailable">
          Recording is unavailable because native capture is not implemented. You can create a draft
          and save personal notes.
        </p>
        <p className="jds-hint">
          Configure processing in <a href="/settings?section=aiproviders">AI providers</a>.
        </p>
        {create.isError ? (
          <p role="alert" className="jds-hint jds-hint--error">
            Couldn’t create or confirm the draft. Correct any invalid title, or retry the same
            request to avoid a duplicate.
          </p>
        ) : null}
        <div className="meetings-actions">
          <Button
            onClick={submit}
            disabled={create.isPending || form.data.createPending || !titleValid}
          >
            {create.isPending || form.data.createPending
              ? "Creating draft…"
              : create.isError || form.data.request
                ? "Retry creating draft"
                : "Create draft"}
          </Button>
          <Button disabled aria-describedby="meeting-capture-unavailable">
            Start meeting
          </Button>
        </div>
      </section>
    </>
  );
}
