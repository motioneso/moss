import { useEffect, useRef } from "react";
import { randomUuid, setSessionUnsavedChanges } from "@moss/module-web-sdk";
import { Button, Field, FormLabel } from "@moss/ui";
import type {
  EditMeetingOutputInput,
  MeetingOutputArtifact,
  MeetingOutputContent
} from "@moss/shared";
import { editMeetingOutput, outputKeys } from "./output-client.js";
import { operationError, useOutputSession, type OutputOperation } from "./output-session.js";
interface EditState {
  readonly content: MeetingOutputContent;
  readonly operation?: OutputOperation<EditMeetingOutputInput>;
}
export function MeetingOutputEditor({
  artifact,
  headVersion,
  onClose,
  onSaved
}: {
  readonly artifact: MeetingOutputArtifact;
  readonly headVersion: number;
  readonly onClose: () => void;
  readonly onSaved?: (version: number) => void;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const session = useOutputSession<EditState>(
    artifact.meetingId,
    `edit:${artifact.version}`,
    () => ({ content: artifact.content })
  );
  const { state, update, client } = session;
  const dirty =
    !!state &&
    JSON.stringify(state.content) !==
      JSON.stringify(
        state.operation?.status === "done" ? state.operation.input.content : artifact.content
      );
  useEffect(() => {
    setSessionUnsavedChanges(
      client,
      `meetings:${artifact.meetingId}:output:${artifact.version}`,
      dirty && !session.denied
    );
  }, [client, artifact.meetingId, artifact.version, dirty, session.denied]);
  if (state === undefined || session.denied)
    return (
      <p role="status" className="jds-hint">
        Summary access is unavailable. Return to history or sign in again.
      </p>
    );
  const busy = state.operation?.status === "running";
  const locked = busy || state.operation?.status === "retry";
  async function save() {
    if (busy || !session.authorized()) return;
    const input =
      state.operation?.status === "retry"
        ? state.operation.input
        : { requestKey: randomUuid(), expectedOutputVersion: headVersion, content: state.content };
    update((current) => ({
      ...current,
      operation: { input, status: "running", message: "Saving a new version…" }
    }));
    try {
      const saved = await editMeetingOutput(artifact.meetingId, input);
      if (!session.authorized()) return;
      setSessionUnsavedChanges(
        client,
        `meetings:${artifact.meetingId}:output:${artifact.version}`,
        false
      );
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : {
              ...current,
              operation: { input, status: "done", message: `Saved version ${saved.version}.` }
            }
      );
      void client.invalidateQueries({ queryKey: outputKeys.list(artifact.meetingId) });
      if (active.current) onSaved?.(saved.version);
    } catch (error) {
      if (session.deny(error) || !session.authorized()) return;
      update((current) =>
        current.operation?.input.requestKey !== input.requestKey
          ? current
          : { ...current, operation: { input, ...operationError(error) } }
      );
    }
  }
  return (
    <div className="meetings-section">
      <p className="jds-hint">
        Manual edits create a new version. Evidence references stay attached; review them when
        changing a claim. Edits are kept during this signed-in session.
      </p>
      <Field>
        <FormLabel htmlFor="output-overview">Overview</FormLabel>
        <textarea
          id="output-overview"
          className="jds-textarea meetings-input"
          rows={5}
          maxLength={4000}
          disabled={locked}
          value={state.content.overview}
          onChange={(event) =>
            update((current) => ({
              ...current,
              content: { ...current.content, overview: event.target.value }
            }))
          }
        />
      </Field>
      {(["decisions", "actions"] as const).map((kind) =>
        state.content[kind].map((item, index) => (
          <Field key={`${kind}-${index}`}>
            <FormLabel htmlFor={`output-${kind}-${index}`}>
              {kind === "decisions" ? "Decision" : "Suggested action"} {index + 1}
            </FormLabel>
            <textarea
              id={`output-${kind}-${index}`}
              className="jds-textarea meetings-input"
              value={item.text}
              maxLength={2000}
              disabled={locked}
              onChange={(event) =>
                update((current) => ({
                  ...current,
                  content: {
                    ...current.content,
                    [kind]: current.content[kind].map((claim, n) =>
                      n === index ? { ...claim, text: event.target.value } : claim
                    )
                  }
                }))
              }
            />
          </Field>
        ))
      )}
      {state.content.openQuestions.map((question, index) => (
        <Field key={index}>
          <FormLabel htmlFor={`output-question-${index}`}>Open question {index + 1}</FormLabel>
          <textarea
            id={`output-question-${index}`}
            className="jds-textarea meetings-input"
            value={question}
            maxLength={2000}
            disabled={locked}
            onChange={(event) =>
              update((current) => ({
                ...current,
                content: {
                  ...current.content,
                  openQuestions: current.content.openQuestions.map((value, n) =>
                    n === index ? event.target.value : value
                  )
                }
              }))
            }
          />
        </Field>
      ))}
      <div className="meetings-actions">
        <Button
          disabled={busy || !dirty || artifact.version !== headVersion}
          onClick={() => void save()}
        >
          {state.operation?.status === "retry" ? "Retry edit save" : "Save edits as new version"}
        </Button>
        <Button variant="quiet" onClick={onClose}>
          Close editor
        </Button>
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            update(() => ({ content: artifact.content }));
            setSessionUnsavedChanges(
              client,
              `meetings:${artifact.meetingId}:output:${artifact.version}`,
              false
            );
            onClose();
          }}
        >
          Discard edits
        </Button>
      </div>
      {artifact.version !== headVersion ? (
        <p role="status" className="jds-hint">
          A newer version exists. Your edits are kept. Compare the latest version before editing it.
        </p>
      ) : null}
      {artifact.version !== headVersion ? (
        <details>
          <summary>Copy kept edits</summary>
          <Field>
            <FormLabel htmlFor="kept-summary-edits">Kept summary edits</FormLabel>
            <textarea
              id="kept-summary-edits"
              className="jds-textarea meetings-input"
              readOnly
              rows={8}
              value={[
                state.content.overview,
                ...state.content.decisions.map((item) => item.text),
                ...state.content.openQuestions,
                ...state.content.actions.map((item) => item.text)
              ].join("\n\n")}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          <p className="jds-hint">
            Copy this text, then choose the latest version to make a new edit. Reopening this
            version restores your kept edits.
          </p>
        </details>
      ) : null}
      {state.operation ? (
        <p role="status" className="jds-hint">
          {state.operation.message}
        </p>
      ) : null}
    </div>
  );
}
