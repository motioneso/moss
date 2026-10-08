import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import { Badge, Button } from "@moss/ui";
import type { MeetingRecord } from "@moss/shared";
import { captureKeys } from "./capture-client.js";
import {
  captureSelection,
  captureRevocationLabel,
  captureStopped,
  captureStatusLabel
} from "./capture-presentation.js";
import { useCaptureSession, startMeetingCapture, type ActiveCapture } from "./capture-session.js";
import { getMeetingPreferences, isMeetingAccessDenied, meetingKeys } from "./client.js";
import { useCaptureStatus } from "./capture-status.js";
import { useCaptureClock } from "./capture-clock.js";
import { CaptureControls } from "./capture-controls.js";
import { useMeetingConnection } from "./meeting-connection.js";
export { captureQueryOptions } from "./capture-status.js";
const settingsPath = "/settings?section=modules&module=meetings";

export function CapturePanel({
  meeting,
  onLiveChange,
  heading
}: {
  readonly meeting: MeetingRecord;
  readonly heading?: ReactNode;
  readonly onLiveChange: (active: boolean) => void;
}) {
  const query = useCaptureStatus(meeting.id);
  const session = useCaptureSession(meeting.id);
  const client = useQueryClient();
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences,
    retry: false
  });
  const connection = useMeetingConnection(preferences.data?.rememberedSource?.deviceId);
  const denied =
    connection.denied ||
    (isMeetingAccessDenied(query.error) &&
      !(query.error instanceof ApiError && query.error.status === 404));
  const capture = denied ? undefined : query.data?.capture;
  const stopped = captureStopped(capture);
  const revoked = capture?.desired === "revoked";
  const live =
    !!session.state.operation || (!!capture && capture.desired !== "idle" && !stopped && !revoked);
  const { connected } = useCaptureClock(capture, query.dataUpdatedAt, query.isError);
  useEffect(() => onLiveChange(live), [live, onLiveChange]);
  useEffect(() => {
    if (live && !denied)
      client.setQueryData<ActiveCapture>(captureKeys.active, {
        meetingId: meeting.id,
        title: meeting.title
      });
  }, [client, meeting.id, meeting.title, live, denied]);
  const inventory = connection.device?.inventory;
  const saved = preferences.data?.rememberedSource;
  const reportedDefault =
    inventory && "defaultMicrophoneId" in inventory ? inventory.defaultMicrophoneId : undefined;
  const defaultMicrophone =
    typeof reportedDefault === "string"
      ? reportedDefault
      : reportedDefault === undefined && inventory?.microphones.length === 1
        ? inventory.microphones[0]!.deviceId
        : "";
  const sourceReady =
    captureSelection(
      {
        mode: preferences.data?.defaultCaptureMode ?? saved?.mode ?? "computer-audio",
        microphoneId: saved?.microphoneId ?? defaultMicrophone,
        applicationId: saved?.applicationId ?? ""
      },
      inventory ?? null
    ) !== null;
  const ready =
    !denied &&
    !preferences.isPending &&
    !preferences.isError &&
    !query.isPending &&
    !query.isError &&
    !connection.loading &&
    !connection.unavailable &&
    !!connection.device &&
    sourceReady &&
    !connection.device.busy &&
    connection.devices.data?.processingReady === true;
  const status = denied
    ? "Recording access is unavailable. Use Trail Marker’s local Stop, then sign in again."
    : query.error instanceof ApiError && query.error.status === 404
      ? "Recording isn’t available on this server yet."
      : query.isError
        ? "Couldn’t confirm the recorder connection."
        : revoked && capture
          ? `${captureRevocationLabel(capture)}. Recording stopped.`
          : (session.state.error ??
            (capture?.observed?.phase === "error"
              ? "Recording was interrupted. Check Trail Marker on your Mac."
              : query.data?.processingReady === false ||
                  connection.devices.data?.processingReady === false
                ? "Transcription isn’t available. Check AI providers."
                : capture?.processing?.status === "delayed"
                  ? "Transcription is delayed. Recording continues."
                  : capture?.finalization === "pending"
                    ? "Still being finalised"
                    : !capture && !connection.loading && !ready
                      ? connection.unavailable
                        ? "Couldn’t confirm the latest Mac connection."
                        : connection.ambiguous
                          ? "More than one Mac is connected. Disconnect the extra Mac in Trail Marker."
                          : connection.device?.busy
                            ? "This Mac is recording or finishing another meeting."
                            : connection.device && !sourceReady
                              ? "The audio source is unavailable. Check microphone and system audio access in Trail Marker, or change Audio source in Settings."
                              : connection.linked.length
                                ? "Open Trail Marker on your Mac to reconnect."
                                : "Open Trail Marker and follow its linking instructions."
                      : null));
  const requestResume = () => {
    if (session.currentSession() && !denied && capture?.desired === "paused")
      void session.control({
        grantId: capture.grantId,
        command: "record",
        expectedGeneration: capture.generation
      });
  };
  return (
    <section className="meetings-capture" aria-label="Meeting recording">
      <div className="meetings-actions meetings-capture-heading">
        {heading ? <div className="meetings-capture-title">{heading}</div> : null}
        {capture && !revoked ? (
          <Badge tone={capture.desired === "recording" && connected ? "red" : "neutral"}>
            {captureStatusLabel(capture, connected)}
          </Badge>
        ) : !capture && ready ? (
          <Badge tone="forest">Ready</Badge>
        ) : null}
        {!capture && !session.state.operation ? (
          <Button
            disabled={
              !ready ||
              query.isPending ||
              query.isError ||
              preferences.isPending ||
              preferences.isError
            }
            onClick={() => {
              if (session.currentSession() && ready && !denied)
                void startMeetingCapture(
                  client,
                  meeting.id,
                  meeting.title,
                  {
                    requestKey: randomUuid()
                  },
                  session.currentSession
                );
            }}
          >
            Start recording
          </Button>
        ) : (
          <CaptureControls
            id={meeting.id}
            capture={capture}
            unavailable={query.isError || denied}
            updatedAt={query.dataUpdatedAt}
            processingReady={query.data?.processingReady}
            onResume={requestResume}
          />
        )}
      </div>
      {!denied && (capture || connection.device) ? (
        <p className="jds-hint">
          {capture?.deviceName ?? connection.device?.deviceName} ·{" "}
          {(capture ? connected : !connection.unavailable) ? "Connected" : "Disconnected"}
        </p>
      ) : null}
      {status ? (
        <p className="jds-hint" role="status">
          {status}{" "}
          {session.state.operation?.phase === "retry" ? (
            <Button
              variant="link"
              disabled={(session.state.operation.retryAt ?? 0) > Date.now()}
              onClick={session.retry}
            >
              Try again
            </Button>
          ) : query.isError || connection.unavailable ? (
            <Button
              variant="link"
              onClick={() => {
                query.refresh();
                connection.refresh();
              }}
            >
              Check again
            </Button>
          ) : !stopped && !revoked ? (
            <Link
              to={
                query.data?.processingReady === false ||
                connection.devices.data?.processingReady === false
                  ? "/settings?section=aiproviders"
                  : settingsPath
              }
            >
              Settings
            </Link>
          ) : null}
        </p>
      ) : null}
      {stopped || revoked ? <Link to="/meetings">New meeting</Link> : null}
    </section>
  );
}
