import {
  Button,
  Field,
  FormLabel,
  Note,
  RadioCardGroup,
  SectionHead,
  Select,
  Switch
} from "@moss/ui";
import { CAPTURE_MODES } from "./capture-modes.js";
import { useMeetingSettings, type MeetingSettingsState } from "./meeting-settings-state.js";
import {
  MeetingMacSettings,
  MeetingReadiness,
  MeetingSettingsSection
} from "./meeting-settings-sections.js";
import { CaptureNotice } from "./capture-notice.js";
import "./meeting-settings.css";

function SourceSettings({ state }: { readonly state: MeetingSettingsState }) {
  const { data, device, chooseSource, saving } = state;
  if (state.macAccessDenied) return null;
  const inventory = device?.inventory;
  const microphones = inventory?.microphones ?? [];
  const applications = inventory?.applications ?? [];
  const microphoneMissing =
    !!data.choice.microphoneId &&
    !microphones.some((item) => item.deviceId === data.choice.microphoneId);
  const applicationMissing =
    !!data.choice.applicationId &&
    !applications.some((item) => item.applicationId === data.choice.applicationId);
  const applicationAmbiguous =
    applications.filter((item) => item.applicationId === data.choice.applicationId).length > 1;
  return (
    <fieldset className="meeting-settings-fields" disabled={saving}>
      <legend className="jds-label">Listen to</legend>
      <RadioCardGroup
        name="meeting-settings-mode"
        ariaLabel="Listen to"
        value={data.choice.mode}
        options={CAPTURE_MODES}
        onChange={(mode) => chooseSource({ mode })}
      />
      <div className="meeting-settings-source-grid">
        <Field>
          <FormLabel htmlFor="meeting-settings-microphone">Microphone</FormLabel>
          <Select
            id="meeting-settings-microphone"
            value={data.choice.microphoneId}
            onChange={(event) => chooseSource({ microphoneId: event.target.value })}
          >
            <option value="">Choose a microphone</option>
            {microphoneMissing ? (
              <option value={data.choice.microphoneId}>Saved microphone is unavailable</option>
            ) : null}
            {microphones.map((microphone) => (
              <option key={microphone.deviceId} value={microphone.deviceId}>
                {microphone.label}
              </option>
            ))}
          </Select>
          {device && !microphones.length ? (
            <p role="status" className="jds-hint">
              Connect a microphone, then refresh sources in Trail Marker.
            </p>
          ) : null}
        </Field>
        {data.choice.mode === "selected-app" ? (
          <Field>
            <FormLabel htmlFor="meeting-settings-app">Meeting app</FormLabel>
            <Select
              id="meeting-settings-app"
              value={data.choice.applicationId}
              onChange={(event) => chooseSource({ applicationId: event.target.value })}
            >
              <option value="">Choose a meeting app</option>
              {applicationMissing ? (
                <option value={data.choice.applicationId}>Saved meeting app is unavailable</option>
              ) : null}
              {applications.map((application) => (
                <option
                  key={application.appProcessTreeId}
                  value={application.applicationId ?? ""}
                  disabled={!application.applicationId}
                >
                  {application.label}
                </option>
              ))}
            </Select>
            {!applications.length ? (
              <p role="status" className="jds-hint">
                Open the meeting app on your Mac, then refresh sources in Trail Marker.
              </p>
            ) : null}
            {applications.some((item) => !item.applicationId) ? (
              <p className="jds-hint">
                Update Trail Marker to select apps by their stable identity.
              </p>
            ) : null}
            {applicationAmbiguous ? (
              <p role="status" className="jds-hint">
                More than one instance of this app is open. Close the extra instance or choose
                another app.
              </p>
            ) : null}
          </Field>
        ) : null}
      </div>
      {data.choice.mode === "computer-audio" ? (
        <Note variant="practical">Other apps, media and notifications may be recorded.</Note>
      ) : null}
      {data.deviceId && !state.selection ? (
        <p role="status" className="jds-hint">
          Check your selected Mac, microphone and app. Moss won’t switch to another source
          automatically.
        </p>
      ) : null}
    </fieldset>
  );
}
function SummarySettings({ state }: { readonly state: MeetingSettingsState }) {
  const templates = state.availability.data?.templates ?? [];
  return (
    <div className="meeting-settings-stack">
      <Switch
        ariaLabel="Write a summary when I stop"
        label="Write a summary when I stop"
        checked={state.data.summarizeOnStop}
        disabled={state.saving}
        onChange={(summarizeOnStop) => state.edit({ summarizeOnStop })}
      />
      <p className="jds-hint">
        A summary and suggested tasks appear next to your notes after the transcript finishes.
      </p>
      <Field>
        <FormLabel htmlFor="meeting-settings-summary-style">Summary style</FormLabel>
        <Select
          id="meeting-settings-summary-style"
          value={state.data.summaryTemplateId}
          disabled={state.saving || !templates.length}
          onChange={(event) => {
            const selected = templates.find((template) => template.id === event.target.value);
            if (selected) state.edit({ summaryTemplateId: selected.id });
          }}
        >
          {!templates.some((template) => template.id === state.data.summaryTemplateId) ? (
            <option value={state.data.summaryTemplateId}>
              {state.data.summaryTemplateId === "general"
                ? "General meeting"
                : "Saved summary style"}
            </option>
          ) : null}
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
        {state.availability.isError ? (
          <p role="status" className="jds-hint">
            Couldn’t load summary styles. Check again to retry.
          </p>
        ) : null}
      </Field>
    </div>
  );
}
export function MeetingSettingsForm({
  setup,
  onCompleted,
  onCancel,
  onRunSetup
}: {
  readonly setup: boolean;
  readonly onCompleted?: () => void;
  readonly onCancel?: () => void;
  readonly onRunSetup?: () => void;
}) {
  const state = useMeetingSettings();
  const preferences = state.preferences.data;
  const notice = <CaptureNotice disabled={state.saving} />;
  return (
    <div className="meeting-settings">
      <header className="meeting-settings-stack">
        <SectionHead title={setup ? "Set up Meetings" : "Meetings"} titleAs="h1" />
        <p className="jds-hint">
          {setup
            ? "Set up once. After this, a meeting is New meeting, then Start."
            : "Used when you press Start or Resume."}
        </p>
      </header>
      {state.preferences.isPending ? (
        <p role="status" className="jds-hint">
          Loading your meeting settings…
        </p>
      ) : state.preferences.isError ? (
        <div className="meeting-settings-stack">
          <p role="alert" className="jds-hint jds-hint--error">
            Couldn’t load your meeting settings. Your choices haven’t been changed.
          </p>
          <Button variant="secondary" onClick={() => void state.preferences.refetch()}>
            Retry loading settings
          </Button>
        </div>
      ) : preferences && state.data.loaded ? (
        <>
          <MeetingMacSettings state={state} onRunSetup={!setup ? onRunSetup : undefined} />
          <MeetingSettingsSection number="02" title={setup ? "Ready to record" : "Recording"}>
            {setup ? (
              <MeetingReadiness state={state} setup />
            ) : (
              <>
                <SourceSettings state={state} />
                {notice}
                <MeetingReadiness state={state} setup={false} />
              </>
            )}
          </MeetingSettingsSection>
          <MeetingSettingsSection
            number="03"
            title={setup ? "Defaults" : "After a meeting"}
            description={setup ? "Change these any time in Settings → Meetings." : undefined}
          >
            {setup ? <SourceSettings state={state} /> : null}
            <SummarySettings state={state} />
            {setup ? notice : null}
          </MeetingSettingsSection>
          {state.data.error ? (
            <p role="alert" className="jds-hint jds-hint--error">
              {state.data.error}
            </p>
          ) : null}
          {state.data.saved && !setup ? (
            <p role="status" className="jds-hint">
              Meeting settings saved.
            </p>
          ) : null}
          {setup && state.data.skippedComputerAudio ? (
            <p role="status" className="jds-hint">
              Computer audio skipped. Meetings will use your microphone only.
            </p>
          ) : null}
          <div className="meeting-settings-actions">
            <Button
              disabled={state.saving || !(setup ? state.canFinishSetup : state.canSave)}
              onClick={() => void state.save(setup, setup ? onCompleted : undefined)}
            >
              {state.saving ? "Saving…" : setup ? "Finish setup" : "Save settings"}
            </Button>
            {onCancel ? (
              <Button variant="secondary" disabled={state.saving} onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            {setup ? (
              <p className="jds-hint">Nothing records until you press Start on a meeting.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
