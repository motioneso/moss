import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, FormLabel, Note, Select } from "@moss/ui";
import type { MeetingCaptureDevice } from "@moss/shared";
import { CaptureRequestError, captureKeys, getCaptureDevices } from "./capture-client.js";
import { CaptureSources } from "./capture-sources.js";
import { CAPTURE_MODES } from "./capture-modes.js";
import { captureSelection, type CaptureChoice } from "./capture-presentation.js";

export function useCaptureDevices() {
  return useQuery({
    queryKey: captureKeys.devices,
    queryFn: ({ signal, client }) => {
      const error = client.getQueryState(captureKeys.devices)?.error;
      if (error instanceof CaptureRequestError && error.retryAt > Date.now()) throw error;
      return getCaptureDevices(signal);
    },
    retry: false,
    staleTime: 5000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.error instanceof CaptureRequestError
        ? Math.max(5000, query.state.error.retryAt - Date.now())
        : 5000,
    refetchIntervalInBackground: false
  });
}
export function CaptureReady({
  devices,
  deviceId,
  choice,
  onDevice,
  onChoice,
  unavailable = false
}: {
  readonly devices: readonly MeetingCaptureDevice[];
  readonly deviceId: string;
  readonly choice: CaptureChoice;
  readonly onDevice: (id: string) => void;
  readonly onChoice: (choice: Partial<CaptureChoice>) => void;
  readonly unavailable?: boolean;
}) {
  const device = devices.find((item) => item.deviceId === deviceId);
  const selection = captureSelection(choice, device?.inventory ?? null);
  const [editing, setEditing] = useState<boolean | null>(null);
  const changing = editing ?? (!deviceId || !selection);
  const microphone = device?.inventory.microphones.find(
    (item) => item.deviceId === choice.microphoneId
  );
  const application = device?.inventory.applications.find(
    (item) => item.applicationId === choice.applicationId
  );
  return (
    <div className="meetings-section">
      <div className="meetings-actions">
        <span className="jds-label">
          {device?.deviceName ?? (deviceId ? "Remembered Mac unavailable" : "Choose your Mac")}
        </span>
        <span className="jds-hint">
          {microphone?.label ??
            (choice.microphoneId ? "Selected microphone unavailable" : "Choose a microphone")}{" "}
          ·{" "}
          {choice.mode === "selected-app"
            ? (application?.label ?? "Selected app unavailable")
            : choice.mode === "microphone-only"
              ? "Output not captured"
              : (CAPTURE_MODES.find((mode) => mode.value === choice.mode)?.label ??
                "Choose capture sources")}
        </span>
        <Button variant="link" onClick={() => setEditing(!changing)}>
          {changing ? "Done changing sources" : "Change"}
        </Button>
      </div>
      {device?.busy ? (
        <p role="status" className="jds-hint">
          {device.capturePhase === "finalizing"
            ? "This Mac is finishing the previous transcript. Start will be available when it finishes."
            : "This Mac already has a meeting in progress. Use its recording controls to pause or stop."}
        </p>
      ) : null}
      {unavailable ? (
        <p role="status" className="jds-hint">
          Couldn’t refresh your connection. Your source choice is kept.
        </p>
      ) : null}
      {choice.mode === "selected-app" &&
      device &&
      device.inventory.applications.filter(
        (application) => application.applicationId === choice.applicationId
      ).length > 1 ? (
        <p role="status" className="jds-hint">
          More than one instance of this app is open. Close the extra instance or choose another
          source.
        </p>
      ) : null}
      {deviceId && !selection ? (
        <p role="status" className="jds-hint">
          Check your selected Mac, microphone and app. Recording will not switch to other sources.
        </p>
      ) : null}
      {changing ? (
        <>
          <Field>
            <FormLabel htmlFor="meeting-capture-device">Recording device</FormLabel>
            <Select
              id="meeting-capture-device"
              value={deviceId}
              onChange={(event) => onDevice(event.target.value)}
            >
              <option value="">Choose a connected Mac</option>
              {deviceId && !device ? (
                <option value={deviceId}>Remembered Mac unavailable</option>
              ) : null}
              {devices.map((item) => (
                <option key={item.deviceId} value={item.deviceId}>
                  {item.deviceName}
                </option>
              ))}
            </Select>
          </Field>
          {device ? (
            <CaptureSources inventory={device.inventory} choice={choice} onChange={onChoice} />
          ) : null}
        </>
      ) : null}
      {!devices.length ? (
        <p className="jds-hint">
          Connect Trail Marker once for Meetings and Backtrack in{" "}
          <Link to="/settings?section=profile">Settings → Profile</Link>. Connecting doesn’t start
          recording.
        </p>
      ) : null}
      {!changing && choice.mode === "computer-audio" ? (
        <Note variant="practical">Other apps, media and notifications can be recorded.</Note>
      ) : null}
      {!choice.mode || !choice.microphoneId ? (
        <p className="jds-hint">
          Start sends these selected audio sources to your configured transcription service. Let
          participants know you’re recording.
        </p>
      ) : null}
    </div>
  );
}
