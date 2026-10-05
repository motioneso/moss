import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import type { MeetingCaptureBrowserStatus, MeetingCaptureControlInput } from "@moss/shared";
import { approveCaptureDevice, captureKeys, controlCapture } from "./capture-client.js";
import { emptyCaptureChoice, type CaptureChoice } from "./capture-presentation.js";
import { isMeetingAccessDenied, meetingKeys } from "./client.js";

type CaptureRequest =
  | { readonly kind: "approve"; readonly challengeId: string }
  | { readonly kind: "control"; readonly input: MeetingCaptureControlInput };
interface CaptureOperation {
  readonly request: CaptureRequest;
  readonly phase: "sending" | "retry";
}
export interface CaptureSession {
  readonly grantId: string | null;
  readonly choice: CaptureChoice;
  readonly operation: CaptureOperation | null;
  readonly error: string | null;
}
export function newCaptureSession(): CaptureSession {
  return { grantId: null, choice: emptyCaptureChoice, operation: null, error: null };
}
export function useCaptureSession(id: string) {
  const client = useQueryClient();
  const key = captureKeys.session(id);
  const query = useQuery({
    queryKey: key,
    queryFn: newCaptureSession,
    initialData: newCaptureSession,
    enabled: false,
    gcTime: Infinity
  });
  const identity = client.getQueryCache().find({ queryKey: key, exact: true });
  const authorized = () =>
    client.getQueryCache().find({ queryKey: key, exact: true }) === identity &&
    !isMeetingAccessDenied(client.getQueryState(meetingKeys.record(id))?.error) &&
    !isMeetingAccessDenied(client.getQueryState(captureKeys.status(id))?.error);
  function update(change: (current: CaptureSession) => CaptureSession) {
    if (authorized())
      client.setQueryData<CaptureSession>(key, (current) =>
        current ? change(current) : undefined
      );
  }
  async function send(request: CaptureRequest) {
    const pending = client.getQueryData<CaptureSession>(key)?.operation;
    if (!authorized() || pending?.phase === "sending" || (pending && pending.request !== request))
      return;
    update((current) => ({ ...current, operation: { request, phase: "sending" }, error: null }));
    await client.cancelQueries({ queryKey: captureKeys.status(id), exact: true });
    if (!authorized()) return;
    try {
      if (request.kind === "approve") await approveCaptureDevice(id, request.challengeId);
      else {
        const result = await controlCapture(id, request.input);
        if (!authorized()) return;
        client.setQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id), (current) =>
          current &&
          current.capture?.grantId === result.capture.grantId &&
          (current.capture.generation < result.capture.generation ||
            (current.capture.generation === result.capture.generation &&
              Date.parse(current.capture.serverTime) <= Date.parse(result.capture.serverTime)))
            ? { ...current, capture: result.capture }
            : current
        );
      }
      if (!authorized()) return;
      update((current) => ({ ...current, operation: null }));
      void client.invalidateQueries({ queryKey: captureKeys.status(id), exact: true });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
    } catch (error) {
      if (!authorized()) return;
      if (isMeetingAccessDenied(error)) {
        client.removeQueries({ queryKey: key, exact: true });
        void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
        void client.invalidateQueries({ queryKey: captureKeys.status(id), exact: true });
        return;
      }
      const processingUnavailable =
        error instanceof ApiError && error.code === "meeting_capture_processing_unavailable";
      const definite =
        processingUnavailable ||
        (error instanceof ApiError && [400, 409, 413, 422].includes(error.status));
      update((current) => ({
        ...current,
        operation: definite ? null : { request, phase: "retry" },
        error: processingUnavailable
          ? "Transcription unavailable. Check Settings → AI providers, then try again."
          : definite
            ? "The capture state changed or these sources are unavailable. Refresh and check the selection."
            : "Couldn’t confirm the command. Check Trail Marker’s recording indicator, then retry the same request."
      }));
      if (definite)
        void client.invalidateQueries({ queryKey: captureKeys.status(id), exact: true });
    }
  }
  return {
    state: query.data,
    bindGrant: (grantId: string) =>
      update((current) =>
        current.grantId === grantId
          ? current
          : {
              ...current,
              grantId,
              choice: { ...emptyCaptureChoice, mode: current.choice.mode }
            }
      ),
    updateChoice: (change: Partial<CaptureChoice>) =>
      update((current) =>
        current.operation ? current : { ...current, choice: { ...current.choice, ...change } }
      ),
    approve: (challengeId: string) => send({ kind: "approve", challengeId }),
    control: (input: Omit<MeetingCaptureControlInput, "requestKey">) =>
      send({ kind: "control", input: { ...input, requestKey: randomUuid() } }),
    retry: () => {
      const request = client.getQueryData<CaptureSession>(key)?.operation?.request;
      if (request) void send(request);
    }
  };
}
