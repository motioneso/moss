import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import type {
  MeetingCaptureBrowserStatus,
  MeetingCaptureControlInput,
  MeetingCaptureCancelStartInput,
  MeetingCaptureStartInput,
  MeetingCaptureState
} from "@moss/shared";
import {
  CaptureRequestError,
  captureKeys,
  controlCapture,
  cancelCaptureStart,
  reconcileCaptureStatus,
  startCapture
} from "./capture-client.js";
import {
  choiceFromCapture,
  emptyCaptureChoice,
  type CaptureChoice
} from "./capture-presentation.js";
import { isMeetingAccessDenied, meetingKeys } from "./client.js";
import { refreshCaptureStatus } from "./capture-status.js";
import { meetingLinkKeys } from "./meeting-link-state.js";
import { useSessionBoundary } from "./session-draft.js";

type CaptureRequest =
  | { readonly kind: "start"; readonly input: MeetingCaptureStartInput }
  | { readonly kind: "cancel-start"; readonly input: MeetingCaptureCancelStartInput }
  | { readonly kind: "control"; readonly input: MeetingCaptureControlInput };
interface CaptureOperation {
  readonly request: CaptureRequest;
  readonly phase: "sending" | "retry";
  readonly retryAt?: number;
}
export interface CaptureSession {
  readonly grantId: string | null;
  readonly startRequest: MeetingCaptureStartInput | null;
  readonly choiceGeneration: number | null;
  readonly choice: CaptureChoice;
  readonly operation: CaptureOperation | null;
  readonly error: string | null;
}
export interface ActiveCapture {
  readonly meetingId: string;
  readonly title: string;
}
export function newCaptureSession(): CaptureSession {
  return {
    grantId: null,
    startRequest: null,
    choiceGeneration: null,
    choice: emptyCaptureChoice,
    operation: null,
    error: null
  };
}
const runs = new WeakMap<QueryClient, Map<string, AbortController>>();
const stopping = new WeakMap<
  QueryClient,
  Map<string, { currentSession: () => boolean; promise: Promise<void> }>
>();
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}
function acceptCapture(
  client: QueryClient,
  id: string,
  capture: MeetingCaptureState,
  start: boolean,
  previousGrantId: string | null = null
) {
  const currentCapture = client.getQueryData<MeetingCaptureBrowserStatus>(
    captureKeys.status(id)
  )?.capture;
  if (
    start &&
    currentCapture &&
    currentCapture.grantId !== capture.grantId &&
    currentCapture.grantId !== previousGrantId
  )
    return false;
  if (
    currentCapture?.grantId === capture.grantId &&
    (currentCapture.generation > capture.generation ||
      (currentCapture.generation === capture.generation &&
        Date.parse(currentCapture.serverTime) > Date.parse(capture.serverTime)))
  )
    return false;
  client.setQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id), (current) => {
    if (
      current?.capture &&
      (current.capture.grantId !== capture.grantId ||
        current.capture.generation > capture.generation) &&
      !start
    )
      return current;
    return {
      ...current,
      capture,
      pendingLinks: [],
      processingReady: current?.processingReady ?? true
    };
  });
  return true;
}
function captureAccessDenied(client: QueryClient, id: string) {
  return [
    meetingKeys.record(id),
    captureKeys.status(id),
    captureKeys.devices,
    meetingLinkKeys.sessions,
    meetingLinkKeys.capabilities
  ].some((key) => isMeetingAccessDenied(client.getQueryState(key)?.error));
}
async function send(
  client: QueryClient,
  id: string,
  request: CaptureRequest,
  currentSession: () => boolean
) {
  const key = captureKeys.session(id);
  const identity = client.getQueryCache().find({ queryKey: key, exact: true });
  const authorized = () =>
    currentSession() &&
    identity === client.getQueryCache().find({ queryKey: key, exact: true }) &&
    !captureAccessDenied(client, id);
  const pending = client.getQueryData<CaptureSession>(key)?.operation;
  const previousGrantId =
    client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id))?.capture?.grantId ??
    null;
  const priority =
    request.kind === "cancel-start" ||
    (request.kind === "control" && request.input.command !== "record");
  if (
    !authorized() ||
    (pending?.request.kind === request.kind &&
      pending.request.input.requestKey === request.input.requestKey &&
      (pending.retryAt ?? 0) > Date.now()) ||
    (pending?.phase === "sending" &&
      pending.request.kind === "control" &&
      request.kind === "control" &&
      (pending.request.input.command === request.input.command ||
        (pending.request.input.command === "stop" && request.input.command !== "revoke"))) ||
    (pending &&
      !priority &&
      (pending.phase === "sending" ||
        pending.request.input.requestKey !== request.input.requestKey))
  )
    return;
  let registry = runs.get(client);
  if (!registry) {
    registry = new Map();
    runs.set(client, registry);
  }
  if (priority) registry.get(id)?.abort();
  const controller = new AbortController();
  registry.set(id, controller);
  let installedRequestKey: string | null = null;
  const current = () =>
    authorized() &&
    registry!.get(id) === controller &&
    (installedRequestKey === null ||
      client.getQueryData<CaptureSession>(key)?.operation?.request.input.requestKey ===
        installedRequestKey);
  const update = (change: Partial<CaptureSession>) => {
    if (!current()) return;
    client.setQueryData<CaptureSession>(key, (value) =>
      value ? { ...value, ...change } : undefined
    );
    if (change.operation) installedRequestKey = change.operation.request.input.requestKey;
  };
  update({
    operation: { request, phase: "sending" },
    error: null,
    ...(request.kind === "start" ? { startRequest: request.input } : {})
  });
  // A control response must never sit behind a long status read.
  await client.cancelQueries({ queryKey: captureKeys.status(id), exact: true });
  for (let attempt = 0; attempt < 3 && current(); attempt += 1) {
    try {
      const result =
        request.kind === "start"
          ? await startCapture(id, request.input, controller.signal)
          : request.kind === "cancel-start"
            ? await cancelCaptureStart(id, request.input, controller.signal)
            : await controlCapture(id, request.input, controller.signal);
      if (!current()) return;
      const accepted = result.capture
        ? acceptCapture(client, id, result.capture, request.kind === "start", previousGrantId)
        : true;
      if (!result.capture && request.kind === "cancel-start") {
        const existing = client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id));
        if (!existing?.capture) {
          client.setQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id), {
            capture: null,
            pendingLinks: [],
            processingReady: existing?.processingReady ?? true
          });
          if (client.getQueryData<ActiveCapture>(captureKeys.active)?.meetingId === id)
            client.setQueryData(captureKeys.active, null);
        }
      }
      update({
        operation: null,
        error: null,
        ...(request.kind === "cancel-start" ? { startRequest: null } : {})
      });
      refreshCaptureStatus(client, id);
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      return accepted;
    } catch (error) {
      if (!current()) return;
      if (isMeetingAccessDenied(error)) {
        client.removeQueries({ queryKey: key, exact: true });
        client.removeQueries({ queryKey: captureKeys.active, exact: true });
        void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
        return;
      }
      if (priority && error instanceof ApiError && error.status === 409 && attempt < 2) {
        try {
          const latest = (await reconcileCaptureStatus(id, controller.signal)).capture;
          if (!current()) return;
          if (latest && request.kind === "control" && latest.grantId === request.input.grantId) {
            acceptCapture(client, id, latest, false);
            if (latest.desired === "stopped" || latest.desired === "revoked") {
              update({ operation: null, error: null });
              return;
            }
            if (latest.generation !== request.input.expectedGeneration) {
              request = {
                kind: "control",
                input: {
                  ...request.input,
                  expectedGeneration: latest.generation,
                  requestKey: randomUuid()
                }
              };
              update({ operation: { request, phase: "sending" } });
              continue;
            }
          }
        } catch {
          /* Fall through to the visible recovery state after the bounded reconciliation. */
        }
      }
      const processingUnavailable =
        error instanceof ApiError && error.code === "meeting_capture_processing_unavailable";
      const recorderBusy = error instanceof ApiError && error.code === "meeting_capture_busy";
      const definite =
        processingUnavailable ||
        (error instanceof ApiError && [400, 409, 413, 422].includes(error.status));
      const delay = Math.max(
        500 * 2 ** attempt,
        error instanceof CaptureRequestError ? error.retryAt - Date.now() : 0
      );
      if (!definite && attempt < 2 && delay <= 5000) {
        try {
          await pause(delay, controller.signal);
        } catch {
          return;
        }
        continue;
      }
      update({
        operation: definite
          ? null
          : {
              request,
              phase: "retry",
              retryAt: error instanceof CaptureRequestError ? error.retryAt : undefined
            },
        error: processingUnavailable
          ? "Transcription unavailable. Check Settings → AI providers, then try again."
          : error instanceof CaptureRequestError && error.status === 429
            ? "The server asked us to wait before retrying. Trail Marker’s local Pause and Stop remain available."
            : recorderBusy
              ? "This Mac is still recording or finishing the previous meeting. Stop it and wait for the transcript to finish, then try Start again."
              : definite
                ? "The connection or audio source changed. Check Trail Marker and try again."
                : "The command is unconfirmed. Check Trail Marker’s indicator. Stop remains available; retry uses the same request."
      });
      if (
        definite &&
        request.kind === "start" &&
        client.getQueryData<ActiveCapture>(captureKeys.active)?.meetingId === id &&
        !client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id))?.capture
      )
        client.setQueryData(captureKeys.active, null);
      refreshCaptureStatus(client, id);
      return;
    }
  }
}
export async function startMeetingCapture(
  client: QueryClient,
  id: string,
  title: string,
  input: MeetingCaptureStartInput,
  currentSession: () => boolean
) {
  if (!currentSession() || captureAccessDenied(client, id)) return false;
  client.setQueryData<CaptureSession>(
    captureKeys.session(id),
    (current) => current ?? newCaptureSession()
  );
  client.setQueryData<ActiveCapture>(captureKeys.active, { meetingId: id, title });
  return send(client, id, { kind: "start", input }, currentSession);
}
export function effectiveCaptureChoice(
  session: CaptureSession,
  capture: MeetingCaptureState | null | undefined
): CaptureChoice {
  if (!capture) return session.choice;
  return session.grantId === capture.grantId && session.choiceGeneration === capture.generation
    ? session.choice
    : choiceFromCapture(capture);
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
  const currentSession = useSessionBoundary(key);
  const retryAt = query.data.operation?.retryAt;
  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) return;
    const timer = setTimeout(() => {
      if (!currentSession()) return;
      client.setQueryData<CaptureSession>(key, (current) =>
        current?.operation?.retryAt === retryAt
          ? { ...current, operation: { ...current.operation, retryAt: undefined } }
          : current
      );
    }, retryAt - Date.now());
    return () => clearTimeout(timer);
  }, [client, id, identity, retryAt]);
  function update(change: (current: CaptureSession) => CaptureSession) {
    if (currentSession())
      client.setQueryData<CaptureSession>(key, (current) =>
        current ? change(current) : undefined
      );
  }
  return {
    state: query.data,
    currentSession,
    bindCapture: (capture: MeetingCaptureState) => {
      const current = client.getQueryData<CaptureSession>(key);
      if (current?.grantId === capture.grantId && current.choiceGeneration === capture.generation)
        return;
      update((current) => ({
        ...current,
        grantId: capture.grantId,
        choiceGeneration: capture.generation,
        choice: choiceFromCapture(capture)
      }));
    },
    updateChoice: (change: Partial<CaptureChoice>) =>
      update((current) => {
        const capture = client.getQueryData<MeetingCaptureBrowserStatus>(
          captureKeys.status(id)
        )?.capture;
        return {
          ...current,
          ...(capture ? { grantId: capture.grantId, choiceGeneration: capture.generation } : {}),
          choice: { ...effectiveCaptureChoice(current, capture), ...change }
        };
      }),
    control: (input: Omit<MeetingCaptureControlInput, "requestKey">) =>
      currentSession()
        ? send(
            client,
            id,
            { kind: "control", input: { ...input, requestKey: randomUuid() } },
            currentSession
          )
        : Promise.resolve(false),
    stop: () => {
      if (!currentSession()) return Promise.resolve();
      let registry = stopping.get(client);
      if (!registry) {
        registry = new Map();
        stopping.set(client, registry);
      }
      const pendingStop = registry.get(id);
      if (pendingStop?.currentSession()) return pendingStop.promise;
      const stopped = (async () => {
        // Stop supersedes an uncertain Start/Pause and reconciles the latest generation first.
        runs.get(client)?.get(id)?.abort();
        await client.cancelQueries({ queryKey: captureKeys.status(id), exact: true });
        if (!currentSession()) return;
        const state = client.getQueryData<CaptureSession>(key);
        let capture = client.getQueryData<MeetingCaptureBrowserStatus>(
          captureKeys.status(id)
        )?.capture;
        const start =
          state?.operation?.request.kind === "start"
            ? state.operation.request.input
            : !capture
              ? state?.startRequest
              : null;
        if (start) {
          if (!currentSession()) return;
          await send(
            client,
            id,
            {
              kind: "cancel-start",
              input: {
                requestKey: start.requestKey
              }
            },
            currentSession
          );
          return;
        }
        if (!capture) {
          try {
            capture = (await reconcileCaptureStatus(id)).capture;
          } catch {
            /* An unresolved Stop stays visible; it never creates a new Start. */
          }
        }
        if (!currentSession()) return;
        if (capture && capture.desired !== "stopped" && capture.desired !== "revoked")
          await send(
            client,
            id,
            {
              kind: "control",
              input: {
                grantId: capture.grantId,
                command: "stop",
                expectedGeneration: capture.generation,
                requestKey: randomUuid()
              }
            },
            currentSession
          );
        else
          update((current) => ({
            ...current,
            operation: null,
            error: capture
              ? null
              : "No recording was confirmed. Check Trail Marker’s local Stop before closing it."
          }));
      })();
      registry.set(id, { currentSession, promise: stopped });
      void stopped.finally(() => {
        if (registry!.get(id)?.promise === stopped) registry!.delete(id);
      });
      return stopped;
    },
    retry: () => {
      if (!currentSession()) return;
      const request = client.getQueryData<CaptureSession>(key)?.operation?.request;
      if (request) void send(client, id, request, currentSession);
    }
  };
}
