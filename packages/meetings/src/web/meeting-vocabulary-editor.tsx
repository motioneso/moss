import { Button, Field, FormLabel, Textarea } from "@moss/ui";
import type { useMeetingVocabulary } from "./meeting-vocabulary-state.js";
export function MeetingVocabularyEditor({
  state,
  disabled
}: {
  state: ReturnType<typeof useMeetingVocabulary>;
  disabled: boolean;
}) {
  return (
    <Field>
      <FormLabel htmlFor="meeting-settings-vocabulary">Transcript vocabulary</FormLabel>
      <Textarea
        id="meeting-settings-vocabulary"
        rows={4}
        maxLength={2000}
        value={state.text}
        disabled={disabled}
        aria-describedby="meeting-vocabulary-hint meeting-vocabulary-validation"
        aria-invalid={!!state.validation}
        onChange={(event) => state.edit(event.target.value)}
      />
      <p id="meeting-vocabulary-hint" className="jds-hint">
        One spelling per line, up to 20. Choose a transcript language and use spellings in that
        language. The complete hint, including separators, must fit within 200 UTF-8 bytes. Saved
        spellings go to your selected audio service for upcoming meeting clips and normal imports.
        Hints are best effort: the service may ignore them and accuracy is not guaranteed. Existing
        text and hold recordings stay unchanged.
      </p>
      <p id="meeting-vocabulary-validation" className="jds-hint" role="status">
        {state.validation}
      </p>
      <div className="meeting-vocabulary-actions">
        <Button disabled={disabled || !!state.validation} onClick={() => void state.save()}>
          Save vocabulary
        </Button>
        <Button variant="quiet" disabled={disabled} onClick={() => void state.clear()}>
          Clear vocabulary
        </Button>
      </div>
      {state.pending ? (
        <p className="jds-hint" role="status">
          Saving vocabulary…
        </p>
      ) : null}
      {state.error ? (
        <p className="jds-hint jds-hint--error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.acknowledgement ? (
        <p className="jds-hint" role="status">
          {state.acknowledgement}
        </p>
      ) : null}
    </Field>
  );
}
