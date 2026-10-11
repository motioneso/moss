import { useQuery } from "@tanstack/react-query";
import { requestJson } from "@moss/module-web-sdk";
import type { ListMySessionsResponse, RecordingCapabilitiesResponse } from "@moss/shared";
import { useCaptureDevices } from "./capture-devices.js";
import { isMeetingAccessDenied } from "./client.js";
import { meetingLinkKeys } from "./meeting-link-state.js";

/** Linking is an account fact; a recorder going offline must not erase it. */
export function useMeetingConnection(preferredDeviceId?: string | null) {
  const devices = useCaptureDevices();
  const sessions = useQuery({
    queryKey: meetingLinkKeys.sessions,
    queryFn: ({ signal }) => requestJson<ListMySessionsResponse>("/api/me/sessions", { signal }),
    retry: false,
    refetchOnWindowFocus: "always"
  });
  const capabilities = useQuery({
    queryKey: meetingLinkKeys.capabilities,
    queryFn: ({ signal }) =>
      requestJson<RecordingCapabilitiesResponse>("/api/companion/recording-capabilities", {
        signal
      }),
    retry: false,
    refetchOnWindowFocus: "always"
  });
  const denied = [sessions.error, capabilities.error, devices.error].some(isMeetingAccessDenied);
  const linked = denied
    ? []
    : (sessions.data?.sessions.filter((session) => session.source === "companion") ?? []);
  const connected = denied
    ? []
    : (devices.data?.devices ?? []).filter(
        (device) =>
          linked.some((session) => session.id === device.deviceId) &&
          capabilities.data?.devices.some(
            (capability) =>
              capability.deviceId === device.deviceId && capability.state === "approved"
          )
      );
  const device = preferredDeviceId
    ? connected.find((item) => item.deviceId === preferredDeviceId)
    : connected.length === 1
      ? connected[0]
      : undefined;
  return {
    sessions,
    capabilities,
    devices,
    linked,
    device,
    ambiguous: !preferredDeviceId && connected.length > 1,
    denied,
    loading: sessions.isPending || capabilities.isPending || devices.isPending,
    unavailable: sessions.isError || capabilities.isError || devices.isError,
    refresh: () => {
      void sessions.refetch();
      void capabilities.refetch();
      void devices.refetch();
    }
  };
}
