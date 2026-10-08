import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { randomUuid, requestJson } from "@moss/module-web-sdk";
import type {
  ListMySessionsResponse,
  MeetingCaptureBrowserStatus,
  MeetingCaptureDevicesResponse,
  RecordingCapabilitiesResponse,
  RevokeMySessionResponse
} from "@moss/shared";
import { captureKeys } from "./capture-client.js";
import { isMeetingAccessDenied } from "./client.js";
import { refreshCaptureStatus } from "./capture-status.js";
import { useSessionDraft } from "./session-draft.js";

export const meetingLinkKeys = {
  sessions: ["settings", "sessions"] as const,
  capabilities: ["companion", "recording-capabilities"] as const,
  action: ["meetings", "link-action"] as const
};
interface LinkAction {
  readonly requestKey: string | null;
  readonly deviceId: string | null;
  readonly message: string | null;
  readonly failed: boolean;
}
const emptyAction = (): LinkAction => ({
  requestKey: null,
  deviceId: null,
  message: null,
  failed: false
});

/** Unlink uses the owner session service; source defaults stay untouched. */
export function useMeetingLinkActions() {
  const client = useQueryClient();
  const action = useSessionDraft(meetingLinkKeys.action, emptyAction);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      client.setQueryData(meetingLinkKeys.action, emptyAction());
    };
  }, [client]);
  function canUnlink(deviceId: string) {
    if (
      !active.current ||
      !action.currentSession() ||
      client.getQueryData<LinkAction>(meetingLinkKeys.action)?.requestKey ||
      [meetingLinkKeys.sessions, meetingLinkKeys.capabilities, captureKeys.devices].some((key) =>
        isMeetingAccessDenied(client.getQueryState(key)?.error)
      ) ||
      client.getQueryState(meetingLinkKeys.sessions)?.status !== "success"
    )
      return false;
    const linked = client
      .getQueryData<ListMySessionsResponse>(meetingLinkKeys.sessions)
      ?.sessions.some((session) => session.id === deviceId && session.source === "companion");
    return !!linked;
  }
  async function unlink(deviceId: string) {
    if (!canUnlink(deviceId)) return false;
    const session = client
      .getQueryData<ListMySessionsResponse>(meetingLinkKeys.sessions)!
      .sessions.find((item) => item.id === deviceId)!;
    const name = session.companion?.displayName ?? session.deviceLabel;
    const requestKey = randomUuid();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12000);
    controller.current = abort;
    action.update(() => ({
      requestKey,
      deviceId,
      failed: false,
      message: `Unlinking ${name}…`
    }));
    const ownsRequest = () =>
      active.current &&
      action.currentSession() &&
      client.getQueryData<LinkAction>(meetingLinkKeys.action)?.requestKey === requestKey;
    try {
      const result = await requestJson<RevokeMySessionResponse>(
        `/api/me/sessions/${encodeURIComponent(deviceId)}`,
        { method: "DELETE", signal: abort.signal }
      );
      if (!result.success) throw new Error("Device unlink was not confirmed");
      if (!ownsRequest()) return false;
      // An older list read must not restore the permission after confirmed revocation.
      const keys = [meetingLinkKeys.sessions, meetingLinkKeys.capabilities, captureKeys.devices];
      await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey, exact: true })));
      if (!ownsRequest()) return false;
      client.setQueryData<ListMySessionsResponse>(meetingLinkKeys.sessions, (current) =>
        current ? { sessions: current.sessions.filter((item) => item.id !== deviceId) } : current
      );
      client.setQueryData<RecordingCapabilitiesResponse>(meetingLinkKeys.capabilities, (current) =>
        current
          ? {
              devices: current.devices.filter((item) => item.deviceId !== deviceId)
            }
          : current
      );
      client.setQueryData<MeetingCaptureDevicesResponse>(captureKeys.devices, (current) =>
        current
          ? { ...current, devices: current.devices.filter((item) => item.deviceId !== deviceId) }
          : current
      );
      action.update(() => ({
        requestKey: null,
        deviceId,
        failed: false,
        message: `${name} unlinked. Your saved notes and transcripts are still available.`
      }));
      for (const queryKey of keys) void client.invalidateQueries({ queryKey, exact: true });
      // Read the server's terminal reason, rather than invent a capture receipt in this browser.
      for (const [key, status] of client.getQueriesData<MeetingCaptureBrowserStatus>({
        queryKey: ["meetings", "capture"]
      })) {
        if (status?.capture?.deviceId !== deviceId || typeof key[2] !== "string") continue;
        void client.invalidateQueries({ queryKey: key, exact: true });
        refreshCaptureStatus(client, key[2]);
      }
      return true;
    } catch {
      if (!ownsRequest()) return false;
      action.update(() => ({
        requestKey: null,
        deviceId,
        failed: true,
        message: `Couldn’t confirm Unlink for ${name}. Check again, then retry. Use Stop in Trail Marker if it is still recording.`
      }));
      return false;
    } finally {
      clearTimeout(timeout);
      if (controller.current === abort) controller.current = null;
    }
  }
  return { ...action.data, pending: !!action.data.requestKey, canUnlink, unlink };
}
