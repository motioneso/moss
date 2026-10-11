import { Button, Field, FormLabel, SectionHead } from "@moss/ui";
import type { useMeetingNotesEditor } from "./use-meeting-notes.js";
export function MeetingNotesPane({
  editor
}: {
  readonly editor: ReturnType<typeof useMeetingNotesEditor>;
}) {
  const { state, dirty, notesValid } = editor;
  return (
    <section className="meetings-section" aria-label="Personal notes">
      <SectionHead title="Notes" rule />
      <textarea
        aria-label="Notes"
        id="meeting-personal-notes"
        className="jds-textarea meetings-input meetings-notes"
        placeholder="Add a note…"
        maxLength={64000}
        value={state.text}
        onChange={(event) => editor.change(event.target.value)}
      />
      <p
        className="jds-hint"
        role="status"
        hidden={!dirty && state.phase === "idle" && !state.text}
      >
        {state.phase === "saving"
          ? "Saving…"
          : state.phase === "failed"
            ? "Couldn’t save. Your edits are kept here."
            : state.phase === "conflict"
              ? "Notes changed elsewhere. Review the saved version."
              : dirty
                ? "Unsaved changes"
                : "Saved"}
      </p>
      {state.phase === "failed" ? (
        <Button
          variant="link"
          disabled={!notesValid && !state.pending}
          onClick={() => void editor.save()}
        >
          Retry save
        </Button>
      ) : null}
      {!notesValid ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Shorten these notes or remove unsupported characters before saving.
        </p>
      ) : null}
      {state.phase === "conflict" ? (
        <div className="meetings-section">
          {editor.conflictLoading ? <p className="jds-hint">Loading current notes…</p> : null}
          {editor.conflictError ? (
            <p role="alert" className="jds-hint jds-hint--error">
              Couldn’t load current notes. Your edits have not been replaced.
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
                  rows={6}
                  value={state.latest.personalNotes}
                />
              </Field>
              <Button variant="secondary" onClick={editor.keepMine}>
                Keep my version
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              disabled={editor.conflictLoading}
              onClick={() => void editor.loadCurrent()}
            >
              Load current notes
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
