import type {
  AdminRevokeSessionsResponse,
  ChatMultiplexerChoice,
  ChatMultiplexerSettingsDto,
  GetAiAdminUserPinResponse,
  HerdrInstallResultDto,
  HostDiagnosticsDto,
  HostRestartResultDto,
  HostRestartStatusDto,
  ListAdminAuditEventsResponse,
  ListAdminConnectorAccountsResponse,
  ListAuthProviderStatusesResponse,
  ListUsersResponse,
  PutAiAdminUserPinRequest,
  RegistrationSettingsDto,
  UserDto
} from "@moss/shared";

import { requestJson } from "./client.js";

export async function listAuthProviderStatuses(): Promise<ListAuthProviderStatusesResponse> {
  return requestJson<ListAuthProviderStatusesResponse>("/api/admin/auth/providers");
}

export async function listAdminConnectorAccounts(): Promise<ListAdminConnectorAccountsResponse> {
  return requestJson<ListAdminConnectorAccountsResponse>("/api/admin/connectors/accounts");
}

export async function listAdminAuditEvents(): Promise<ListAdminAuditEventsResponse> {
  return requestJson<ListAdminAuditEventsResponse>("/api/admin/audit-events");
}

export async function listAdminUsers(): Promise<ListUsersResponse> {
  return requestJson<ListUsersResponse>("/api/admin/users");
}

export async function approveUser(id: string): Promise<{ user: UserDto }> {
  return requestJson<{ user: UserDto }>(`/api/admin/users/${encodeURIComponent(id)}/approve`, {
    method: "POST"
  });
}

export async function rejectUser(id: string): Promise<{ rejectedUserId: string }> {
  return requestJson<{ rejectedUserId: string }>(
    `/api/admin/users/${encodeURIComponent(id)}/reject`,
    { method: "POST" }
  );
}

export async function deactivateUser(id: string): Promise<{ user: UserDto }> {
  return requestJson<{ user: UserDto }>(`/api/admin/users/${encodeURIComponent(id)}/deactivate`, {
    method: "POST"
  });
}

export async function reactivateUser(id: string): Promise<{ user: UserDto }> {
  return requestJson<{ user: UserDto }>(`/api/admin/users/${encodeURIComponent(id)}/reactivate`, {
    method: "POST"
  });
}

export async function promoteUser(id: string): Promise<{ user: UserDto }> {
  return requestJson<{ user: UserDto }>(`/api/admin/users/${encodeURIComponent(id)}/promote`, {
    method: "POST"
  });
}

export async function demoteUser(id: string): Promise<{ user: UserDto }> {
  return requestJson<{ user: UserDto }>(`/api/admin/users/${encodeURIComponent(id)}/demote`, {
    method: "POST"
  });
}

export async function deleteAdminUser(id: string): Promise<{ deletedUserId: string }> {
  return requestJson<{ deletedUserId: string }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function revokeAdminUserSessions(id: string): Promise<AdminRevokeSessionsResponse> {
  return requestJson<AdminRevokeSessionsResponse>(
    `/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`,
    { method: "POST" }
  );
}

export async function getAdminUserAiPin(userId: string): Promise<GetAiAdminUserPinResponse> {
  return requestJson<GetAiAdminUserPinResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/ai-pin`
  );
}

export async function putAdminUserAiPin(
  userId: string,
  input: PutAiAdminUserPinRequest
): Promise<GetAiAdminUserPinResponse> {
  return requestJson<GetAiAdminUserPinResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/ai-pin`,
    {
      method: "PUT",
      body: input
    }
  );
}

export async function getRegistrationSettings(): Promise<RegistrationSettingsDto> {
  return requestJson<RegistrationSettingsDto>("/api/admin/registration");
}

export async function putRegistrationSettings(
  body: RegistrationSettingsDto
): Promise<RegistrationSettingsDto> {
  return requestJson<RegistrationSettingsDto>("/api/admin/registration", {
    method: "PUT",
    body
  });
}

export async function getChatMultiplexerSettings(): Promise<ChatMultiplexerSettingsDto> {
  return requestJson<ChatMultiplexerSettingsDto>("/api/admin/chat-multiplexer");
}

export async function setChatMultiplexerSettings(
  multiplexer: ChatMultiplexerChoice
): Promise<ChatMultiplexerSettingsDto> {
  return requestJson<ChatMultiplexerSettingsDto>("/api/admin/chat-multiplexer", {
    method: "PUT",
    body: { multiplexer }
  });
}

export async function getHostDiagnostics(): Promise<HostDiagnosticsDto> {
  return requestJson<HostDiagnosticsDto>("/api/admin/host/diagnostics");
}

export async function installHerdr(): Promise<HerdrInstallResultDto> {
  return requestJson<HerdrInstallResultDto>("/api/admin/host/install", { method: "POST" });
}

// #1748 — admin "Restart app". The POST takes no body: the app's only capability is to ask,
// and there is nothing for a caller to choose (see host-restart-routes.ts).
export async function getHostRestartStatus(): Promise<HostRestartStatusDto> {
  return requestJson<HostRestartStatusDto>("/api/admin/host/restart");
}

export async function requestHostRestart(): Promise<HostRestartResultDto> {
  return requestJson<HostRestartResultDto>("/api/admin/host/restart", { method: "POST" });
}
