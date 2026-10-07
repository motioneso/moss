import { useEffect } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SectionHead } from "@moss/ui";
import { randomUuid } from "@moss/module-web-sdk";
import type { MeetingCaptureState, MeetingRecord } from "@moss/shared";
import { captureKeys } from "./capture-client.js";
import { CAPTURE_MODES } from "./capture-modes.js";
import { captureAcknowledged, captureStopped } from "./capture-presentation.js";
import { useCaptureSession, startMeetingCapture, type ActiveCapture } from "./capture-session.js";
import { CaptureGaps } from "./capture-gaps.js";
import { isMeetingAccessDenied } from "./client.js";
import { useCaptureStatus } from "./capture-status.js";
import { CaptureControls } from "./capture-controls.js";
import { useReadyCapture } from "./capture-choice.js";
export { captureQueryOptions } from "./capture-status.js";

function CaptureScope({ capture }: { readonly capture: MeetingCaptureState }) {
  const selection = capture.selection;
  if (!selection) return null;
  const microphone = capture.inventory?.microphones.find(
    (item) => item.deviceId === selection.microphone.deviceId
  );
  const application =
    selection.mode === "selected-app"
      ? capture.inventory?.applications.find(
          (item) => item.appProcessTreeId === selection.appProcessTreeId
        )
      : null;
  return (
    <div className="meetings-section">
      <span className="jds-label">
        {capture.deviceName} · {CAPTURE_MODES.find((mode) => mode.value === selection.mode)?.label}
      </span>
      <span className="jds-hint">
        {microphone?.label ?? "Selected microphone unavailable"} ·{" "}
        {selection.mode === "microphone-only"
          ? "Output not captured"
          : selection.mode === "selected-app"
            ? (application?.label ?? "Selected app unavailable")
            : "Computer audio, including other apps and notifications"}
      </span>
    </div>
  );
}
function StartExistingMeeting({ meeting }: { readonly meeting: MeetingRecord }) {
  const ready = useReadyCapture();
  const client = useQueryClient();
  const session = useCaptureSession(meeting.id);
  const canStart =
    !!ready.device &&
    !ready.device.busy &&
    !!ready.selection &&
    ready.devices.data?.processingReady === true &&
    !ready.devices.isError &&
    !ready.preferences.isError &&
    !ready.preferences.isPending &&
    !session.state.operation;
  return (
    <>
      <p className="jds-hint">
        {ready.device
          ? `${ready.device.deviceName} · Connected`
          : "Open Trail Marker and follow its linking instructions."}
      </p>
      {ready.device?.busy ? (
        <p role="status" className="jds-hint">
          {ready.device.capturePhase === "finalizing"
            ? "This Mac is finishing the previous transcript. Start will be available when it finishes."
            : "This Mac already has a meeting in progress. Use its recording controls to pause or stop."}
        </p>
      ) : ready.device && !ready.selection ? (
        <p role="status" className="jds-hint">
          Check your Mac’s default microphone and audio permissions in Trail Marker.
        </p>
      ) : null}
      <Button
        disabled={!canStart}
        onClick={() => {
          if (!canStart || !session.currentSession() || !ready.device || !ready.selection) return;
          void startMeetingCapture(
            client,
            meeting.id,
            meeting.title,
            {
              deviceId: ready.device.deviceId,
              connectionId: ready.device.connectionId,
              expectedRevision: ready.device.revision,
              requestKey: randomUuid()
            },
            session.currentSession
          );
        }}
      >
        Start recording
      </Button>
    </>
  );
}
export function CapturePanel({
  meeting,
  onLiveChange
}: {
  readonly meeting: MeetingRecord;
  readonly onLiveChange: (active: boolean) => void;
}) {
  const query = useCaptureStatus(meeting.id);
  const session = useCaptureSession(meeting.id);
  const client = useQueryClient();
  const accessDenied = isMeetingAccessDenied(query.error);
  const capture = accessDenied ? undefined : query.data?.capture;
  const stopped = captureStopped(capture);
  const revoked = capture?.desired === "revoked";
  const live =
    !!session.state.operation || (!!capture && capture.desired !== "idle" && !stopped && !revoked);
  useEffect(() => {
    onLiveChange(live);
  }, [live, onLiveChange]);
  useEffect(() => {
    if (live && !accessDenied)
      client.setQueryData<ActiveCapture>(captureKeys.active, {
        meetingId: meeting.id,
        title: meeting.title
      });
  }, [client, meeting.id, meeting.title, live, accessDenied]);
  return (
    <section className="meetings-section" aria-label="Meeting capture">
      <SectionHead
        number="01"
        title={live ? "Live meeting" : stopped ? "Meeting ended" : "Ready to record"}
        rule
      />
      {query.isPending ? (
        <p role="status" className="jds-hint">
          Checking Trail Marker…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {accessDenied
            ? "Capture access is unavailable. Sign in again or return to meeting history."
            : "Connection unconfirmed. Your source choice is kept. Trail Marker’s local Pause and Stop remain available."}
        </p>
      ) : null}
      {!accessDenied ? (
        <CaptureControls
          id={meeting.id}
          capture={capture}
          unavailable={query.isError}
          updatedAt={query.dataUpdatedAt}
          processingReady={query.data?.processingReady}
        />
      ) : null}
      {capture ? (
        <>
          <CaptureScope capture={capture} />
          <CaptureGaps capture={capture} />
        </>
      ) : null}
      {!accessDenied && !capture && !query.isPending ? (
        <StartExistingMeeting meeting={meeting} />
      ) : null}
      {query.data && !query.data.processingReady ? (
        <p role="status" className="jds-hint">
          Transcription unavailable. Check{" "}
          <Link to="/settings?section=aiproviders">AI providers</Link>.
        </p>
      ) : null}
      {capture?.observed?.phase === "error" ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Capture interrupted. Check your selected sources in Trail Marker, then pause and
          explicitly resume. Sources never switch automatically.
        </p>
      ) : null}
      {stopped ? (
        <p role="status" className="jds-hint">
          {capture?.finalization === "pending"
            ? "Capture stopped. Finishing the retained transcript."
            : capture && !captureAcknowledged(capture)
              ? "Recording authorization has ended. Check Trail Marker’s local Stop; you can review this meeting or start a new one."
              : "Capture stopped. Review your transcript or start a new meeting."}
        </p>
      ) : null}
      {live ? (
        <p className="jds-hint">
          Recording controls stay available as you browse Moss. Trail Marker’s menu also has local
          Pause and Stop.
        </p>
      ) : null}
      <div className="meetings-actions">
        <Button variant="link" onClick={query.refresh}>
          Refresh capture status
        </Button>
        {stopped || revoked ? <Link to="/meetings">New meeting</Link> : null}
      </div>
    </section>
  );
}
