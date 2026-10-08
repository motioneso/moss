import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { MeetingCaptureBrowserStatus } from "@moss/shared";
import { CaptureRequestError, captureKeys, getCaptureStatus } from "./capture-client.js";
import { isMeetingAccessDenied, meetingKeys } from "./client.js";

export function captureQueryOptions(id: string) {
  return {
    queryKey: captureKeys.status(id),
    queryFn: async ({ signal, client }: { signal: AbortSignal; client: QueryClient }) => {
      try {
        const previous = client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(id));
        return await getCaptureStatus(id, signal, previous?.revision);
      } catch (error) {
        if (!signal.aborted && isMeetingAccessDenied(error)) {
          client.removeQueries({ queryKey: captureKeys.session(id), exact: true });
          client.removeQueries({ queryKey: captureKeys.active, exact: true });
          void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
        }
        throw error;
      }
    },
    retry: false as const,
    staleTime: 0,
    gcTime: Infinity,
    refetchOnWindowFocus: false
  };
}
interface StatusLoop {
  subscribers: number;
  wake: () => void;
  close: () => void;
}
const loops = new WeakMap<QueryClient, Map<string, StatusLoop>>();
const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
export function captureNeedsUpdates(data: MeetingCaptureBrowserStatus | undefined): boolean {
  const capture = data?.capture;
  if (!capture) return false;
  if (capture.finalization === "pending")
    return Date.parse(capture.finalizationDeadline ?? "") > Date.parse(capture.serverTime);
  if (capture.desired === "revoked" || capture.finalization === "complete") return false;
  return (
    capture.desired !== "stopped" ||
    capture.observed?.phase !== "stopped" ||
    capture.observed.generation !== capture.generation
  );
}
function subscribeStatus(client: QueryClient, id: string): () => void {
  let registry = loops.get(client);
  if (!registry) {
    registry = new Map();
    loops.set(client, registry);
  }
  let loop = registry.get(id);
  if (!loop) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let running = false;
    let failures = 0;
    let retryAt = 0;
    let again = false;
    let transcriptRevision =
      client.getQueryData<{ snapshot: { transcriptRevision: number } }>(meetingKeys.transcript(id))
        ?.snapshot.transcriptRevision ?? 0;
    const identity = client.getQueryCache().find({ queryKey: captureKeys.status(id), exact: true });
    const current = () =>
      !closed &&
      identity === client.getQueryCache().find({ queryKey: captureKeys.status(id), exact: true });
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (current() && visible())
        timer = setTimeout(() => void read(), Math.max(delay, retryAt - Date.now()));
    };
    const read = async () => {
      if (!current() || !visible()) return;
      if (running) {
        again = true;
        return;
      }
      if (Date.now() < retryAt) {
        schedule(0);
        return;
      }
      running = true;
      try {
        const data = await client.fetchQuery(captureQueryOptions(id));
        if (!current()) return;
        failures = 0;
        if (
          data.capture?.transcriptRevision !== undefined &&
          data.capture.transcriptRevision !== transcriptRevision
        ) {
          transcriptRevision = data.capture.transcriptRevision;
          void client.invalidateQueries({ queryKey: meetingKeys.transcript(id), exact: true });
        }
        if (captureNeedsUpdates(data) || again) schedule(Math.max(1000, data.retryAfterMs ?? 1000));
      } catch (error) {
        if (!current() || isMeetingAccessDenied(error)) return;
        failures += 1;
        retryAt = error instanceof CaptureRequestError ? error.retryAt : 0;
        schedule(Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4)));
      } finally {
        running = false;
        again = false;
      }
    };
    const wake = () => {
      if (current() && visible()) {
        clearTimeout(timer);
        void read();
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (visible()) wake();
      else void client.cancelQueries({ queryKey: captureKeys.status(id), exact: true });
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
    loop = {
      subscribers: 0,
      wake,
      close: () => {
        closed = true;
        clearTimeout(timer);
        if (typeof document !== "undefined")
          document.removeEventListener("visibilitychange", visibility);
        void client.cancelQueries({ queryKey: captureKeys.status(id), exact: true });
      }
    };
    registry.set(id, loop);
    wake();
  }
  loop.subscribers += 1;
  return () => {
    if (--loop.subscribers === 0) {
      loop.close();
      registry!.delete(id);
    }
  };
}
export function refreshCaptureStatus(client: QueryClient, id: string): void {
  loops.get(client)?.get(id)?.wake();
}
export function useCaptureStatus(id: string) {
  const client = useQueryClient();
  const query = useQuery({ ...captureQueryOptions(id), enabled: false });
  useEffect(() => subscribeStatus(client, id), [client, id]);
  return { ...query, refresh: () => refreshCaptureStatus(client, id) };
}
