import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Badge, Button, ButtonLink, Indicator, Note, SectionHead } from "@moss/ui";
import type { MeetingCaptureState, MeetingRecord } from "@moss/shared";
import { captureKeys, getCaptureStatus } from "./capture-client.js";
import { CAPTURE_MODES } from "./capture-modes.js";
import {
  captureAcknowledged,
  captureConnected,
  captureSelection,
  captureStatusLabel
} from "./capture-presentation.js";
import { useCaptureSession } from "./capture-session.js";
import { CaptureGaps } from "./capture-gaps.js";
import { CaptureSources } from "./capture-sources.js";
import { isMeetingAccessDenied, meetingKeys } from "./client.js";
import { transcriptTime } from "./meeting-transcript.js";

export function captureQueryOptions(id: string) {
  return {
    queryKey: captureKeys.status(id),
    queryFn: async ({ signal, client }: { signal: AbortSignal; client: QueryClient }) => {
      try {
        return await getCaptureStatus(id, signal);
      } catch (error) {
        if (!signal.aborted && isMeetingAccessDenied(error)) {
          client.removeQueries({ queryKey: captureKeys.session(id), exact: true });
          void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
        }
        throw error;
      }
    },
    retry: false as const,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: "always" as const
  };
}
export function captureHandoffUrl(origin: string, meetingId: string): string {
  return `moss-meeting://capture?${new URLSearchParams({ instance: origin, meetingId })}`;
}
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
        {CAPTURE_MODES.find((mode) => mode.value === selection.mode)?.label}
      </span>
      <span className="jds-hint">
        {microphone?.label ?? "Selected microphone unavailable"} ·{" "}
        {selection.mode === "microphone-only"
          ? "Output not captured"
          : selection.mode === "selected-app"
            ? (application?.label ?? "Selected app unavailable")
            : "Computer audio, excluding Trail Marker and native Moss apps"}
      </span>
      {selection.mode === "computer-audio" ? (
        <Note variant="practical">Other apps, media, and notifications can be recorded.</Note>
      ) : null}
    </div>
  );
}

export function CapturePanel({
  meeting,
  onLiveChange
}: {
  readonly meeting: MeetingRecord;
  readonly onLiveChange: (active: boolean) => void;
}) {
  const session = useCaptureSession(meeting.id);
  const query = useQuery({
    ...captureQueryOptions(meeting.id),
    refetchInterval: session.state.operation?.phase === "sending" ? false : 1000,
    refetchIntervalInBackground: true
  });
  const client = useQueryClient();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const accessDenied = isMeetingAccessDenied(query.error);
  const data = accessDenied ? undefined : query.data;
  const capture = data?.capture;
  const {
    bindGrant,
    state: { grantId: choiceGrantId }
  } = session;
  useEffect(() => {
    if (capture && choiceGrantId !== capture.grantId) bindGrant(capture.grantId);
  }, [capture, choiceGrantId, bindGrant]);
  const serverNow = capture
    ? Date.parse(capture.serverTime) + Math.max(0, now - query.dataUpdatedAt)
    : now;
  const connected = !!capture && !query.isError && captureConnected(capture, serverNow);
  const acknowledged = !!capture && captureAcknowledged(capture);
  const stopped = capture?.desired === "stopped" && acknowledged;
  const revoked = capture?.desired === "revoked";
  const pendingRecord =
    session.state.operation?.request.kind === "control" &&
    session.state.operation.request.input.command === "record";
  const live = pendingRecord || (!!capture && !stopped && !revoked && capture.desired !== "idle");
  const processing =
    !!capture?.finalizationDeadline && Date.parse(capture.finalizationDeadline) > serverNow;
  useEffect(() => {
    onLiveChange(live);
  }, [live, onLiveChange]);
  useEffect(() => {
    if (!live || typeof window === "undefined") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);
  useEffect(() => {
    if (!live && !processing) return;
    const refresh = () => {
      void client.invalidateQueries({ queryKey: meetingKeys.transcript(meeting.id), exact: true });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [client, meeting.id, live, processing]);
  const choice = session.state.choice;
  const selection = captureSelection(choice, capture?.inventory ?? null);
  const busy = session.state.operation !== null;
  const canChoose =
    !!capture &&
    choiceGrantId === capture.grantId &&
    !busy &&
    connected &&
    (capture.desired === "idle" || capture.desired === "paused") &&
    acknowledged;
  const canRecord = canChoose && !!selection && choice.notice && data?.processingReady === true;
  const handoff =
    typeof window !== "undefined" && window.location?.origin
      ? captureHandoffUrl(window.location.origin, meeting.id)
      : null;
  const label = query.isPending
    ? "Checking connection…"
    : query.isError
      ? "Capture status unconfirmed"
      : capture
        ? captureStatusLabel(capture, connected)
        : "Trail Marker not connected";
  return (
    <section className="meetings-section" aria-label="Meeting capture">
      <SectionHead number="01" title={live ? "Live meeting" : "Check the sources"} rule />
      {query.isPending ? (
        <p role="status" className="jds-hint">
          Checking Trail Marker…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {accessDenied
            ? "Capture access is unavailable. Sign in again or return to meeting history."
            : "Couldn’t confirm capture status. Check Trail Marker on your Mac before recording or closing it."}
        </p>
      ) : null}
      <div className="meetings-actions">
        <span role="status">
          <Indicator
            status={connected ? (live ? "drift" : "ready") : "idle"}
            live={connected && capture?.observed?.phase === "recording"}
            label={label}
          />
        </span>
        {capture ? (
          <>
            <span className="jds-hint">{capture.deviceName}</span>
            <span className="jds-label">
              {transcriptTime(capture.stopCutoffMs ?? capture.elapsedMs)}
            </span>
          </>
        ) : null}
      </div>
      {capture ? <CaptureScope capture={capture} /> : null}
      {capture ? <CaptureGaps capture={capture} /> : null}
      {!accessDenied && (!capture || !connected || revoked) ? (
        <div className="meetings-section">
          <p className="jds-hint">
            Open Trail Marker on a supported Mac and choose Prepare this meeting. Approve that
            device here before recording.
          </p>
          <div className="meetings-actions">
            {handoff ? (
              <ButtonLink href={handoff} variant="secondary">
                Open Trail Marker
              </ButtonLink>
            ) : null}
            <Button variant="link" onClick={() => void query.refetch()}>
              Refresh capture status
            </Button>
          </div>
        </div>
      ) : null}
      {data?.pendingLinks
        .filter((link) => Date.parse(link.expiresAt) > now)
        .map((link) => (
          <Note key={link.challengeId} variant="practical">
            <div className="meetings-section">
              <span>
                Allow {link.deviceName} to capture “{meeting.title}”?
              </span>
              <span className="jds-hint">
                Device: {link.deviceId}. This approval is for this meeting. Recording starts only
                after you choose Record.
              </span>
              <div className="meetings-actions">
                <Button disabled={busy} onClick={() => void session.approve(link.challengeId)}>
                  Approve this device
                </Button>
              </div>
            </div>
          </Note>
        ))}
      {canChoose && capture.inventory ? (
        <CaptureSources
          inventory={capture.inventory}
          choice={choice}
          onChange={session.updateChoice}
        />
      ) : null}
      {data && !data.processingReady ? (
        <p role="status" className="jds-hint">
          Transcription unavailable. Check{" "}
          <Link to="/settings?section=aiproviders">AI providers</Link>.
        </p>
      ) : null}
      {capture && !stopped && !revoked ? (
        <div className="meetings-actions">
          {capture.desired === "idle" || capture.desired === "paused" ? (
            <Button
              disabled={!canRecord}
              onClick={() => {
                if (!canRecord || !selection) return;
                void session.control({
                  grantId: capture.grantId,
                  command: "record",
                  expectedGeneration: capture.generation,
                  selection,
                  noticeAcknowledged: true
                });
              }}
            >
              {capture.desired === "paused" ? "Resume" : "Record"}
            </Button>
          ) : null}
          {capture.desired === "recording" ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void session.control({
                  grantId: capture.grantId,
                  command: "pause",
                  expectedGeneration: capture.generation
                })
              }
            >
              Pause
            </Button>
          ) : null}
          {capture.desired !== "idle" ? (
            <Button
              disabled={busy || capture.desired === "stopped"}
              onClick={() =>
                void session.control({
                  grantId: capture.grantId,
                  command: "stop",
                  expectedGeneration: capture.generation
                })
              }
            >
              Stop and review
            </Button>
          ) : null}
        </div>
      ) : null}
      {capture && !acknowledged && capture.desired !== "idle" && !revoked ? (
        <p role="status" className="jds-hint">
          Waiting for Trail Marker to confirm. Check its recording indicator; capture may still be
          active.
        </p>
      ) : null}
      {revoked ? (
        <p role="status" className="jds-hint">
          Check Trail Marker’s indicator to confirm capture has stopped.
        </p>
      ) : null}
      {stopped ? (
        <p role="status" className="jds-hint">
          {processing
            ? "Capture stopped. Final transcript chunks may still arrive."
            : "Capture stopped. Review the retained transcript below."}
        </p>
      ) : null}
      {live ? (
        <p className="jds-hint">
          Trail Marker’s menu-bar indicator stays available when you leave this page. Use it to
          check or stop recording. Signing out ends the connection.
        </p>
      ) : null}
      {capture?.observed?.phase === "error" ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Check the selected sources and permissions in Trail Marker. Capture will not switch
          sources automatically.
        </p>
      ) : null}
      {session.state.error ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {session.state.error}
        </p>
      ) : null}
      {session.state.operation?.phase === "sending" ? (
        <p role="status" className="jds-hint">
          Sending command…
        </p>
      ) : null}
      {session.state.operation?.phase === "retry" ? (
        <div className="meetings-actions">
          <Button onClick={session.retry}>Retry capture command</Button>
        </div>
      ) : null}
      {capture && !revoked ? (
        <div className="meetings-actions">
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() =>
              void session.control({
                grantId: capture.grantId,
                command: "revoke",
                expectedGeneration: capture.generation
              })
            }
          >
            {live ? "Stop and disconnect device" : "Disconnect device"}
          </Button>
          <Badge tone="neutral">Source labels only</Badge>
        </div>
      ) : null}
    </section>
  );
}
