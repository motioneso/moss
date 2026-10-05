import { Field, FormLabel, Note, RadioCardGroup, Select, Switch } from "@moss/ui";
import type { MeetingCaptureInventory } from "@moss/shared";
import { CAPTURE_MODES } from "./capture-modes.js";
import type { CaptureChoice } from "./capture-presentation.js";

export function CaptureSources({
  inventory,
  choice,
  onChange
}: {
  readonly inventory: MeetingCaptureInventory;
  readonly choice: CaptureChoice;
  readonly onChange: (choice: Partial<CaptureChoice>) => void;
}) {
  return (
    <>
      <RadioCardGroup
        name="meeting-live-capture-mode"
        ariaLabel="Capture mode"
        value={choice.mode}
        options={CAPTURE_MODES}
        onChange={(mode) => onChange({ mode })}
      />
      <div className="meetings-sources">
        <Field>
          <FormLabel htmlFor="meeting-capture-microphone">Microphone</FormLabel>
          <Select
            id="meeting-capture-microphone"
            value={choice.microphoneId}
            onChange={(event) => onChange({ microphoneId: event.target.value })}
          >
            <option value="">Choose a microphone</option>
            {inventory.microphones.map((microphone) => (
              <option key={microphone.deviceId} value={microphone.deviceId}>
                {microphone.label}
              </option>
            ))}
          </Select>
          <p className="jds-hint">
            {inventory.microphonePermission === "granted"
              ? "Microphone permission granted"
              : "Allow microphone access in Trail Marker and macOS System Settings."}
          </p>
        </Field>
        {choice.mode === "selected-app" ? (
          <Field>
            <FormLabel htmlFor="meeting-capture-application">Selected app</FormLabel>
            <Select
              id="meeting-capture-application"
              value={choice.applicationId}
              onChange={(event) => onChange({ applicationId: event.target.value })}
            >
              <option value="">Choose a meeting app</option>
              {inventory.applications.map((application) => (
                <option key={application.appProcessTreeId} value={application.appProcessTreeId}>
                  {application.label}
                </option>
              ))}
            </Select>
            {!inventory.applications.length ? (
              <p className="jds-hint">
                Open the meeting app on your Mac, then refresh the sources in Trail Marker.
              </p>
            ) : null}
          </Field>
        ) : (
          <Field>
            <FormLabel>Output scope</FormLabel>
            <p className="jds-hint">
              {choice.mode === "microphone-only"
                ? "Not captured"
                : choice.mode === "computer-audio"
                  ? "Computer audio, excluding Trail Marker and native Moss apps"
                  : "Choose a capture mode"}
            </p>
          </Field>
        )}
      </div>
      {choice.mode === "computer-audio" ? (
        <Note variant="practical">
          Computer audio can include other apps, media, and notifications.
        </Note>
      ) : null}
      {choice.mode &&
      choice.mode !== "microphone-only" &&
      inventory.systemAudioPermission !== "granted" ? (
        <p className="jds-hint">
          {inventory.systemAudioPermission === "denied"
            ? "Allow system audio recording for Trail Marker in macOS System Settings, then refresh the sources."
            : "macOS may ask for system audio permission when you choose Record."}
        </p>
      ) : null}
      {choice.mode === "computer-audio" && !inventory.computerAudio.available ? (
        <p role="status" className="jds-hint">
          Computer audio is unavailable on this Mac. Choose another mode explicitly.
        </p>
      ) : null}
      <Switch
        ariaLabel="Participants have been notified and recording is permitted"
        label="Participants have been notified and recording is permitted."
        checked={choice.notice}
        onChange={(notice) => onChange({ notice })}
      />
    </>
  );
}
