import type {
  CreateHeartbeatMuteResponse,
  GetHeartbeatSettingsResponse,
  GetHeartbeatStatusResponse,
  ListHeartbeatMutesResponse,
  PutHeartbeatSettingsRequest,
  PutHeartbeatSettingsResponse
} from "@moss/shared";

import { requestJson } from "./client.js";

export async function getHeartbeatSettings(): Promise<GetHeartbeatSettingsResponse> {
  return requestJson<GetHeartbeatSettingsResponse>("/api/me/heartbeat/settings");
}

export async function putHeartbeatSettings(
  input: PutHeartbeatSettingsRequest
): Promise<PutHeartbeatSettingsResponse> {
  return requestJson<PutHeartbeatSettingsResponse>("/api/me/heartbeat/settings", {
    method: "PUT",
    body: input
  });
}

export async function getHeartbeatStatus(): Promise<GetHeartbeatStatusResponse> {
  return requestJson<GetHeartbeatStatusResponse>("/api/me/heartbeat/status");
}

export async function listHeartbeatMutes(): Promise<ListHeartbeatMutesResponse> {
  return requestJson<ListHeartbeatMutesResponse>("/api/me/heartbeat/mutes");
}

export async function deleteHeartbeatMute(id: string): Promise<void> {
  await requestJson(`/api/me/heartbeat/mutes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function createHeartbeatMute(findingId: string): Promise<CreateHeartbeatMuteResponse> {
  return requestJson<CreateHeartbeatMuteResponse>("/api/me/heartbeat/mutes", {
    method: "POST",
    body: { findingId }
  });
}
