import { useState } from "react";
import { Badge, Button, Divider, Field, FormLabel, SectionHead, Select, Switch } from "@moss/ui";
import { MEETING_TRANSCRIPT_LANGUAGES } from "@moss/shared";
import { useMeetingSettings } from "./meeting-settings-state.js";
import { MeetingUnlinkDialog } from "./meeting-unlink-dialog.js";
import "./meeting-settings.css";

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const languages = MEETING_TRANSCRIPT_LANGUAGES.map((code) => ({
  code,
  name: languageNames.of(code) ?? code
})).sort((a, b) => a.name.localeCompare(b.name, "en"));

export function MeetingSettingsForm() {
  const state = useMeetingSettings();
  const [unlink, setUnlink] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="meeting-settings">
      <SectionHead title="Meetings" titleAs="h1" />
      {state.denied ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Mac access could not be verified. Sign in again.
        </p>
      ) : state.loading ? (
        <p role="status" className="jds-hint">
          Checking your linked Mac…
        </p>
      ) : (
        <>
          <div className="meeting-settings-macs">
            {state.linked.map((session) => {
              const name = session.companion?.displayName ?? session.deviceLabel;
              return (
                <div key={session.id}>
                  <div className="meeting-settings-mac">
                    <strong>{name}</strong>
                    <Badge tone={state.unavailable ? "amber" : "forest"}>
                      {state.unavailable ? "Link status unconfirmed" : "Linked"}
                    </Badge>
                  </div>
                  <Divider />
                </div>
              );
            })}
            {!state.linked.length && !state.unavailable ? (
              <p className="jds-hint">
                No Mac linked. Open Trail Marker and follow its linking instructions.
              </p>
            ) : null}
          </div>
          {state.unavailable ? (
            <p role="status" className="jds-hint">
              Couldn’t confirm the latest Mac connection.{" "}
              <Button variant="link" onClick={state.refresh}>
                Check again
              </Button>
            </p>
          ) : null}
        </>
      )}
      {state.preferences.isPending ? (
        <p role="status" className="jds-hint">
          Loading your meeting settings…
        </p>
      ) : state.preferences.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Couldn’t load your meeting settings.{" "}
          <Button variant="link" onClick={() => void state.preferences.refetch()}>
            Retry loading settings
          </Button>
        </p>
      ) : !state.denied ? (
        <div className="meeting-settings-audio">
          <Field>
            <FormLabel htmlFor="meeting-settings-audio-source">Audio source</FormLabel>
            <Select
              id="meeting-settings-audio-source"
              value={state.data.mode}
              disabled={state.saving}
              onChange={(event) => {
                const mode = event.target.value;
                if (mode === "computer-audio" || mode === "microphone-only") void state.save(mode);
              }}
            >
              {state.data.mode === "selected-app" ? (
                <option value="selected-app" disabled>
                  Selected app (saved)
                </option>
              ) : null}
              <option value="computer-audio">Microphone + system audio</option>
              <option value="microphone-only">Microphone only</option>
            </Select>
          </Field>
          <Field>
            <FormLabel htmlFor="meeting-settings-transcript-language">
              Transcript language
            </FormLabel>
            <Select
              id="meeting-settings-transcript-language"
              aria-describedby="meeting-settings-language-hint"
              value={state.data.transcriptLanguage ?? ""}
              disabled={state.saving}
              onChange={(event) => void state.saveLanguage(event.target.value || null)}
            >
              <option value="">Automatic detection</option>
              {languages.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </Select>
            <p id="meeting-settings-language-hint" className="jds-hint">
              Choose the spoken language for new meeting transcription requests, including imported
              recordings. This also applies to the next part of a recording already processing. Your
              transcription service must support the chosen language and language hints. If it
              rejects the choice, choose a supported language or Automatic detection for subsequent
              requests. Failed normal imports cannot be restarted; their evidence stays retained.
              Existing transcript text and hold-to-talk stay unchanged.
            </p>
          </Field>
          <Switch
            ariaLabel="Summarize automatically after Stop"
            label="Summarize automatically after Stop"
            checked={state.data.summarizeOnStop}
            disabled={state.saving}
            onChange={(enabled) => void state.saveSummary(enabled)}
          />
          <p className="jds-hint">
            Send the finalized transcript and notes to your default model after Stop or when an
            imported recording finishes transcription. Turn this off to use Rewrite summary only
            when you choose.
          </p>
          {state.data.requestKey ? (
            <p role="status" className="jds-hint">
              Saving…
            </p>
          ) : null}
          {state.data.error ? (
            <p role="alert" className="jds-hint jds-hint--error">
              {state.data.error}{" "}
              <Button variant="link" onClick={state.retry}>
                Retry
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}
      {!state.denied &&
        state.linked.map((session) => {
          const name = session.companion?.displayName ?? session.deviceLabel;
          return (
            <div key={session.id}>
              <Button
                variant="quiet"
                aria-label={state.linked.length > 1 ? `Unlink ${name}` : undefined}
                disabled={state.saving || !state.links.canUnlink(session.id)}
                onClick={() => setUnlink({ id: session.id, name })}
              >
                Unlink Mac
              </Button>
            </div>
          );
        })}
      {state.links.message ? (
        <p
          role={state.links.failed ? "alert" : "status"}
          className={state.links.failed ? "jds-hint jds-hint--error" : "jds-hint"}
        >
          {state.links.message}
        </p>
      ) : null}
      {unlink && state.linked.some((session) => session.id === unlink.id) ? (
        <MeetingUnlinkDialog
          name={unlink.name}
          pending={state.links.pending}
          allowed={state.links.canUnlink(unlink.id)}
          error={
            state.links.failed && state.links.deviceId === unlink.id ? state.links.message : null
          }
          onClose={() => setUnlink(null)}
          onConfirm={() => {
            void state.links.unlink(unlink.id).then((confirmed) => {
              if (confirmed) setUnlink(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}
