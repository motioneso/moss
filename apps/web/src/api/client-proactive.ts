import type {
  ProactiveCardsResponse,
  ProactiveMonitoringSettingsDto,
  ProactiveMonitoringPreferenceV1
} from "@moss/shared";

import { requestJson } from "./client.js";

export async function getProactiveCards(): Promise<ProactiveCardsResponse> {
  return requestJson<ProactiveCardsResponse>("/api/me/proactive-cards");
}

export async function getProactiveMonitoringSettings(): Promise<ProactiveMonitoringSettingsDto> {
  return requestJson<ProactiveMonitoringSettingsDto>("/api/me/proactive-monitoring-settings");
}

export async function patchProactiveMonitoringSettings(
  patch: Pick<ProactiveMonitoringPreferenceV1, "automaticEmailAlerts">
): Promise<ProactiveMonitoringSettingsDto> {
  return requestJson<ProactiveMonitoringSettingsDto>("/api/me/proactive-monitoring-settings", {
    method: "PATCH",
    body: patch
  });
}
