import { ApiError } from "@moss/module-web-sdk";
import type {
  MeetingCaptureBrowserStatus,
  MeetingCaptureControlInput,
  MeetingCaptureCancelStartInput,
  MeetingCaptureCancelStartResult,
  MeetingCaptureState,
  MeetingCaptureDevicesResponse,
  MeetingCaptureStartInput
} from "@moss/shared";

export const captureKeys = {
  devices: ["meetings", "capture-devices"] as const,
  active: ["meetings", "active-capture"] as const,
  status: (id: string) => ["meetings", "capture", id] as const,
  session: (id: string) => ["meetings", "capture-session", id] as const
};
const capturePath = (id: string) => `/api/meetings/records/${encodeURIComponent(id)}/capture`;

export class CaptureRequestError extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    readonly retryAt: number
  ) {
    super(status, message, code);
  }
}
export function retryAfterTime(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value) || 0;
}

/** Capture requests have a deadline and retain Retry-After, unlike ordinary resource reads. */
async function captureRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeout = 12000
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Capture request timed out")), timeout);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        code?: string;
      };
      throw new CaptureRequestError(
        response.status,
        error.message ?? error.error ?? response.statusText,
        error.code,
        retryAfterTime(response.headers.get("retry-after"))
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export function getCaptureDevices(signal?: AbortSignal): Promise<MeetingCaptureDevicesResponse> {
  return captureRequest("/api/meetings/capture/devices", undefined, signal);
}
export function getCaptureStatus(
  id: string,
  signal?: AbortSignal,
  revision?: string
): Promise<MeetingCaptureBrowserStatus> {
  const query = revision ? `?${new URLSearchParams({ revision, waitMs: "20000" })}` : "";
  return captureRequest(`${capturePath(id)}${query}`, undefined, signal, revision ? 30000 : 12000);
}
export function reconcileCaptureStatus(
  id: string,
  signal?: AbortSignal
): Promise<MeetingCaptureBrowserStatus> {
  return captureRequest(capturePath(id), undefined, signal, 2000);
}
export function startCapture(
  id: string,
  body: MeetingCaptureStartInput,
  signal?: AbortSignal
): Promise<{ capture: MeetingCaptureState }> {
  return captureRequest(`${capturePath(id)}/start`, body, signal);
}
export function controlCapture(
  id: string,
  body: MeetingCaptureControlInput,
  signal?: AbortSignal
): Promise<{ capture: MeetingCaptureState }> {
  return captureRequest(`${capturePath(id)}/control`, body, signal);
}

export function cancelCaptureStart(
  id: string,
  body: MeetingCaptureCancelStartInput,
  signal?: AbortSignal
): Promise<MeetingCaptureCancelStartResult> {
  return captureRequest(`${capturePath(id)}/cancel-start`, body, signal);
}
