import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid, setSessionUnsavedChanges } from "@moss/module-web-sdk";
import { Button, Field, FormLabel, SectionHead, Select } from "@moss/ui";
import type { ManualTranscriptInput } from "@moss/shared";
import { addManualTranscript, getRecordingTypes, recordingKeys } from "./recording-client.js";
import { meetingKeys } from "./client.js";
import { useSessionDraft } from "./session-draft.js";

interface EntryDraft {
  title: string;
  typeId: string;
  transcript: string;
  request?: ManualTranscriptInput;
  phase: "idle" | "saving" | "retry" | "failed";
  error?: string;
}
export function ManualEntry({
  onBack,
  onSaved
}: {
  readonly onBack: () => void;
  readonly onSaved: (id: string) => void;
}) {
  const client = useQueryClient();
  const draft = useSessionDraft<EntryDraft>(["meetings", "manual-entry"], () => ({
    title: "",
    typeId: "",
    transcript: "",
    phase: "idle"
  }));
  const types = useQuery({
    queryKey: recordingKeys.types,
    queryFn: ({ signal }) => getRecordingTypes(signal),
    retry: false
  });
  const { data, update } = draft;
  const dirty = !!(data.title || data.transcript || data.typeId);
  useEffect(() => {
    setSessionUnsavedChanges(client, "meetings:manual-entry", dirty);
  }, [client, dirty]);
  const locked = data.phase === "saving" || data.phase === "retry";
  async function submit() {
    if (data.phase === "saving" || !data.transcript.trim() || !draft.currentSession()) return;
    const input = data.request ?? {
      requestKey: randomUuid(),
      transcript: data.transcript,
      ...(data.title.trim() ? { title: data.title.trim() } : {}),
      ...(data.typeId ? { typeId: data.typeId } : {})
    };
    update((current) => ({ ...current, request: input, phase: "saving", error: undefined }));
    try {
      const result = await addManualTranscript(input);
      if (!draft.currentSession()) return;
      update(() => ({ title: "", typeId: "", transcript: "", phase: "idle" }));
      setSessionUnsavedChanges(client, "meetings:manual-entry", false);
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      onSaved(result.meetingId);
    } catch (error) {
      if (!draft.currentSession()) return;
      const rejected = error instanceof ApiError && [400, 409, 413].includes(error.status);
      update((current) => ({
        ...current,
        phase: rejected ? "failed" : "retry",
        request: rejected ? undefined : input,
        error: rejected
          ? "Check the title, type and transcript, then try again."
          : "Couldn’t confirm your recording. Retry to check the same submission."
      }));
    }
  }
  return (
    <section className="meetings-section" aria-label="Add recording">
      <Button variant="link" disabled={locked} onClick={onBack}>
        Meetings
      </Button>
      <SectionHead title="Add recording" titleAs="h1" />
      <form
        className="meetings-section"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="meetings-manual-fields">
          <Field>
            <FormLabel htmlFor="recording-title">Title (optional)</FormLabel>
            <input
              id="recording-title"
              className="jds-input meetings-input"
              maxLength={240}
              value={data.title}
              disabled={locked}
              onChange={(event) => update((current) => ({ ...current, title: event.target.value }))}
            />
          </Field>
          <Field>
            <FormLabel htmlFor="recording-type">Type (optional)</FormLabel>
            <Select
              id="recording-type"
              value={data.typeId}
              disabled={locked || !types.data || types.isError}
              onChange={(event) =>
                update((current) => ({ ...current, typeId: event.target.value }))
              }
            >
              <option value="">Automatic</option>
              {types.data?.types
                .filter((type) => !type.retired)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field>
          <FormLabel htmlFor="recording-transcript">Transcript</FormLabel>
          <textarea
            id="recording-transcript"
            className="jds-textarea meetings-input"
            rows={14}
            maxLength={100000}
            value={data.transcript}
            disabled={locked}
            placeholder="Paste or type the transcript here…"
            onChange={(event) =>
              update((current) => ({ ...current, transcript: event.target.value }))
            }
          />
        </Field>
        <p className="jds-hint">
          Moss will choose a title and type, decide personal or work, and write a summary. Any title
          or type you provide will be kept.
        </p>
        {types.isError ? (
          <p role="alert" className="jds-hint jds-hint--error">
            Couldn’t load recording types.{" "}
            <Button variant="link" onClick={() => void types.refetch()}>
              Try again
            </Button>
          </p>
        ) : null}
        {data.error ? (
          <p role="alert" className="jds-hint jds-hint--error">
            {data.error}
          </p>
        ) : null}
        <div className="meetings-actions">
          <Button
            type="submit"
            disabled={
              data.phase === "saving" || !data.transcript.trim() || !types.data || types.isError
            }
          >
            {data.phase === "saving"
              ? "Adding recording…"
              : data.phase === "retry"
                ? "Retry adding recording"
                : "Add recording"}
          </Button>
          <Button variant="secondary" disabled={locked} onClick={onBack}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
